import path from 'node:path';
import { MERCURY_ROOT } from './state.mjs';

/**
 * Resolve the coupling map used by both prompt injection and the deterministic
 * plan gate. Relative overrides are always Mercury-root-relative, matching the
 * service's other path configuration.
 */
export function resolveCouplingMapPath() {
  const configured = process.env.MERCURY_COUPLING_MAP || 'coupling-map.yaml';
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(MERCURY_ROOT, configured);
}
