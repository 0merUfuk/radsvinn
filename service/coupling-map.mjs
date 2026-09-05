import { readEnv } from '../dashboard/lib/env.mjs';
import path from 'node:path';
import { RADSVINN_ROOT } from './state.mjs';

/**
 * Resolve the coupling map used by both prompt injection and the deterministic
 * plan gate. Relative overrides are always Radsvinn-root-relative, matching the
 * service's other path configuration.
 */
export function resolveCouplingMapPath() {
  const configured = readEnv('RADSVINN_COUPLING_MAP') || 'coupling-map.yaml';
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(RADSVINN_ROOT, configured);
}
