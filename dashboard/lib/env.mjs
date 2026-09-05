// Shared config boundary for all Node entrypoints. Kept in dashboard/lib so
// the standalone dashboard image/package includes it without copying code.
// Read on demand: callers retain their existing parse/default/snapshot rules.
export function readEnv(name, env = process.env) {
  if (Object.hasOwn(env, name)) return env[name];
  if (name.startsWith('RADSVINN_')) return env[`MERCURY_${name.slice('RADSVINN_'.length)}`];
  return env[name];
}
