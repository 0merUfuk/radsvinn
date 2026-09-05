import { readEnv } from '../../dashboard/lib/env.mjs';
import { createClaudeRuntime } from './claude.mjs';
import { createCodexRuntime } from './codex.mjs';

const RUNTIMES = new Map([
  ['claude', createClaudeRuntime],
  ['codex', createCodexRuntime],
]);

export function resolveRuntime(env = process.env) {
  const id = readEnv('RADSVINN_AGENT_RUNTIME', env) || 'claude';
  const factory = RUNTIMES.get(id);
  if (!factory) throw new Error('Unknown RADSVINN_AGENT_RUNTIME; expected claude or codex');
  const runtime = factory(env);
  if (!runtime.binaryPath) {
    throw new Error(`RADSVINN_AGENT_RUNTIME=${id}: runtime binary not found on PATH (${runtime.binaryName})`);
  }
  return runtime;
}
