import { sandboxedEnv, redactSecrets } from '../../dashboard/lib/child-env.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const MALFORMED_ROLE_PREFIX = 'Ignoring malformed agent role definition';
const CODEX_STRIP_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
];

export function resolveBinaryPath(binaryName, env = process.env) {
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not executable in this PATH entry; keep looking.
    }
  }
  return null;
}

export function parseCodexEvents(stdout, env = process.env) {
  let sessionId;
  let agentMessage;
  let usage;
  const lines = String(stdout ?? '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      throw new Error(`codex returned malformed JSONL at line ${index + 1}`);
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
      sessionId = event.thread_id;
      continue;
    }

    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
      if (typeof event.item.text === 'string' && event.item.text.trim()) agentMessage = event.item.text;
      continue;
    }

    if (event.type === 'item.completed' && event.item && event.item.type === 'error') {
      const message = typeof event.item.message === 'string' ? event.item.message : 'unknown Codex error';
      if (message.startsWith(MALFORMED_ROLE_PREFIX)) continue;
      throw new Error(`codex reported an error event: ${redactSecrets(redactSecrets(message, env))}`);
    }

    if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      usage = event.usage;
    }
  }

  return { sessionId, agentMessage, usage };
}

function requestedCodexModel(seat) {
  const model = typeof seat?.model === 'string' ? seat.model.trim() : '';
  const defaultModel = typeof seat?.defaultModel === 'string' ? seat.defaultModel.trim() : '';
  if (!model || model === 'default' || model === 'codex-default' || model === 'opus' || model === defaultModel) {
    return undefined;
  }
  return model;
}

function codexChildEnv(source) {
  const env = sandboxedEnv(source || {});
  for (const key of CODEX_STRIP_ENV_KEYS) delete env[key];
  return env;
}

export function buildFreshArgs({ prompt, outputPath, repoRoot, groundingRoot, seat }) {
  const args = [
    'exec', prompt,
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--output-last-message', outputPath,
    '-C', repoRoot,
  ];

  if (typeof groundingRoot === 'string' && groundingRoot.trim() && fs.existsSync(groundingRoot)) {
    args.push('--add-dir', groundingRoot);
  }

  const model = requestedCodexModel(seat);
  if (model) args.push('-m', model);

  return args;
}

export function buildResumeArgs({ sessionId, prompt, outputPath }) {
  return [
    'exec', 'resume', sessionId, prompt,
    '--json',
    '--output-last-message', outputPath,
  ];
}

function spawnTimeoutMs(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function defaultRunCodexSpawn({ binaryPath, args, cwd, env, timeoutMs }) {
  const safe = (text) => redactSecrets(redactSecrets(text, env));
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`codex call timed out after ${timeoutMs}ms and was SIGKILLed. stderr tail: ${safe(stderr).slice(-2000)}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn codex: ${safe(err.message)}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex exited ${code}. stderr tail: ${safe(stderr).slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr, wallMs: Date.now() - startedAt });
    });
  });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function coldResumePrompt(priorArtifactText, userMessage) {
  if (!nonEmptyString(priorArtifactText)) return userMessage;
  return `Your prior output was:\n\n${priorArtifactText}\n\nNow proceed with the following:\n\n${userMessage}`;
}

export function createCodexRuntime(
  env = process.env,
  {
    runCodexSpawn = defaultRunCodexSpawn,
    resolveBinaryPath: resolveBinary = resolveBinaryPath,
  } = {},
) {
  const binaryName = 'codex';
  const binaryPath = resolveBinary(binaryName, env);

  return {
    id: 'codex',
    binaryName,
    binaryPath,
    capabilities: {
      supportsTurnCap: false,
      supportsEffort: false,
      supportsCostReporting: false,
    },

    async runPhase(req) {
      if (!binaryPath) throw new Error('codex runtime binary not found on PATH');
      if (!req || typeof req !== 'object') throw new Error('codex runPhase requires a request');
      if (!nonEmptyString(req.repoRoot)) throw new Error('codex runPhase requires repoRoot');
      if (!nonEmptyString(req.userMessage)) throw new Error('codex runPhase requires userMessage');
      if (req.resume && !nonEmptyString(req.sessionId)) throw new Error('codex resume requires sessionId');
      if (!req.childEnv || typeof req.childEnv !== 'object') {
        throw new Error('codex runPhase requires a sandboxed childEnv');
      }

      const outputPath = path.join(os.tmpdir(), `radsvinn-codex-${process.pid}-${randomUUID()}.txt`);
      const timeoutMs = spawnTimeoutMs(req.timeoutMs);
      const phaseStartedAt = Date.now();
      // Codex authenticates from ~/.codex/auth.json. Provider API keys are not
      // needed and must not enter its read-shell sandbox.
      const childEnv = codexChildEnv(req.childEnv);

      const runAttempt = async (args) => {
        fs.rmSync(outputPath, { force: true });
        const startedAt = Date.now();
        const spawned = await runCodexSpawn({
          binaryPath,
          args,
          cwd: req.repoRoot,
          env: childEnv,
          timeoutMs,
          outputPath,
        });
        const events = parseCodexEvents(spawned?.stdout, req.childEnv);

        let outputText;
        try {
          if (fs.existsSync(outputPath)) outputText = fs.readFileSync(outputPath, 'utf8');
        } catch {
          // The event-stream agent message remains the documented backup.
        }

        const text = nonEmptyString(outputText) ?? nonEmptyString(events.agentMessage);
        if (!text) throw new Error('codex returned no result text');
        const sessionId = nonEmptyString(events.sessionId);
        if (!sessionId) throw new Error('codex event stream did not include a thread id');

        return {
          text,
          sessionId,
          costUsd: undefined,
          durationMs: Number.isFinite(spawned?.wallMs) ? spawned.wallMs : Date.now() - startedAt,
          numTurns: undefined,
          model: requestedCodexModel(req.seat) ?? 'codex-default',
          costTelemetryStatus: 'unavailable',
        };
      };

      try {
        if (req.resume) {
          try {
            return await runAttempt(buildResumeArgs({
              sessionId: req.sessionId,
              prompt: req.userMessage,
              outputPath,
            }));
          } catch {
            const prompt = coldResumePrompt(req.priorArtifactText, req.userMessage);
            const freshResult = await runAttempt(buildFreshArgs({
              prompt,
              outputPath,
              repoRoot: req.repoRoot,
              groundingRoot: req.groundingRoot,
              seat: req.seat,
            }));
            return {
              ...freshResult,
              // Cold fallback is one logical phase. Include the failed resume
              // attempt instead of reporting only the successful fresh call.
              durationMs: Date.now() - phaseStartedAt,
            };
          }
        }

        return await runAttempt(buildFreshArgs({
          prompt: req.userMessage,
          outputPath,
          repoRoot: req.repoRoot,
          groundingRoot: req.groundingRoot,
          seat: req.seat,
        }));
      } finally {
        fs.rmSync(outputPath, { force: true });
      }
    },
  };
}
