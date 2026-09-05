import { createClaudeRuntime } from './claude.mjs';
import { createCodexRuntime } from './codex.mjs';

const RUNTIMES = new Map([
  ['claude', createClaudeRuntime],
  ['codex', createCodexRuntime],
]);

export function resolveRuntime(env = process.env) {
  const id = env.MERCURY_AGENT_RUNTIME || 'claude';
  const factory = RUNTIMES.get(id);
  if (!factory) throw new Error(`Unknown MERCURY_AGENT_RUNTIME: ${id}`);
  const runtime = factory(env);
  if (!runtime.binaryPath) {
    throw new Error(`MERCURY_AGENT_RUNTIME=${id}: runtime binary not found on PATH (${runtime.binaryName})`);
  }
  return runtime;
}
