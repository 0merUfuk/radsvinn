import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CALL_TIMEOUT_MS = 45 * 60 * 1000;

export function resolveBinaryPath(binaryName, env = process.env) {
  if (typeof binaryName !== 'string' || binaryName.length === 0) return null;
  const searchPath = typeof env.PATH === 'string' ? env.PATH : '';
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.resolve(entry, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function allowedTools(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  return entries.map((tool) => String(tool).trim()).filter(Boolean);
}

/**
 * Build Claude Code's runtime-specific argv. Engine-owned policy is passed in
 * through `seat`, `maxTurns`, and `groundingRoot`; this module intentionally
 * does not import engine.mjs.
 */
export function buildClaudeArgs(req, env = process.env) {
  const {
    userMessage,
    sessionId,
    resume,
    regen,
    seat = {},
    modelOverride,
    groundingRoot,
  } = req;
  const permissionMode = req.permissionMode || env.MERCURY_AGENT_PERMISSION_MODE || 'default';
  const configuredTools = req.allowedTools
    ?? env.MERCURY_AGENT_ALLOWED_TOOLS
    ?? 'Read,Grep,Glob';
  const model = modelOverride || seat.model || 'opus';
  const effort = seat.effort || 'xhigh';
  const maxTurns = req.maxTurns ?? req.turnCap;

  const args = ['-p', userMessage, '--output-format', 'json'];
  const effectiveResume = regen ? true : Boolean(resume);
  const effectiveSessionId = regen ? regen.sessionId : sessionId;
  if (effectiveResume) args.push('--resume', effectiveSessionId);
  else args.push('--session-id', effectiveSessionId);

  // The former `--agent jira-planner` flag is deliberately absent. Phase 0
  // proved that its missing definition was silently ignored by Claude Code.
  args.push('--permission-mode', permissionMode);
  args.push('--model', model);
  args.push('--effort', effort);

  if (maxTurns !== undefined) {
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      throw new Error('Claude runtime maxTurns must be a positive integer when supplied');
    }
    args.push('--max-turns', String(maxTurns));
  }

  const tools = allowedTools(configuredTools);
  if (tools.length > 0) args.push('--allowedTools', ...tools);
  if (typeof groundingRoot === 'string' && groundingRoot.length > 0 && fs.existsSync(groundingRoot)) {
    args.push('--add-dir', groundingRoot);
  }
  return args;
}

export function runClaudeSpawn({
  binaryPath,
  args,
  repoRoot,
  childEnv,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    return Promise.reject(new Error('failed to spawn claude: runtime binary is unavailable'));
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return Promise.reject(new Error('failed to spawn claude: repoRoot is required'));
  }
  if (!childEnv || typeof childEnv !== 'object') {
    return Promise.reject(new Error('failed to spawn claude: sandboxed childEnv is required'));
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('failed to spawn claude: timeoutMs must be a positive integer'));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binaryPath, args, {
        cwd: repoRoot,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`failed to spawn claude: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude call timed out after ${timeoutMs}ms and was SIGKILLed. stderr tail: ${stderr.slice(-2000)}`));
    }, timeoutMs);

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}. stderr tail: ${stderr.slice(-2000)}`));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        reject(new Error(`claude returned non-JSON stdout despite --output-format json: ${err.message}. stdout tail: ${stdout.slice(-2000)}`));
        return;
      }
      if (parsed.is_error) {
        reject(new Error(`claude reported is_error=true. result: ${JSON.stringify(parsed.result).slice(0, 2000)}. stderr tail: ${stderr.slice(-2000)}`));
        return;
      }
      resolve(parsed);
    });
  });
}

export function createClaudeRuntime(env = process.env, { spawnImpl = spawn } = {}) {
  const binaryName = 'claude';
  const binaryPath = resolveBinaryPath(binaryName, env);

  return {
    id: 'claude',
    binaryName,
    binaryPath,
    capabilities: {
      supportsTurnCap: true,
      supportsEffort: true,
      supportsCostReporting: true,
    },

    async runPhase(req) {
      if (!binaryPath) {
        throw new Error('MERCURY_AGENT_RUNTIME=claude: runtime binary not found on PATH (claude)');
      }
      const args = buildClaudeArgs(req, env);
      const runSpawn = (childEnv = req.childEnv) => runClaudeSpawn({
        binaryPath,
        args,
        repoRoot: req.repoRoot,
        childEnv,
        timeoutMs: req.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        spawnImpl,
      });

      const startedAt = Date.now();
      const execution = req.execute
        ? await req.execute({ args, runSpawn })
        : { parsed: await runSpawn() };
      const parsed = execution && execution.parsed;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('claude runtime execution returned no parsed result');
      }

      const text = typeof parsed.result === 'string'
        ? parsed.result
        : JSON.stringify(parsed.result);
      const effectiveSessionId = req.regen ? req.regen.sessionId : req.sessionId;
      const result = {
        text,
        sessionId: parsed.session_id || effectiveSessionId,
        costUsd: typeof execution.costUsd === 'number'
          ? execution.costUsd
          : (typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0),
        durationMs: Number.isFinite(parsed.duration_ms)
          ? parsed.duration_ms
          : Date.now() - startedAt,
        numTurns: Number.isFinite(parsed.num_turns) ? parsed.num_turns : undefined,
        model: req.reportedModel || req.modelOverride || req.seat?.model || 'opus',
        costTelemetryStatus: 'ok',
      };
      if (Number.isSafeInteger(execution.costNanos) && execution.costNanos >= 0) {
        result.costNanos = execution.costNanos;
      }
      return result;
    },
  };
}
