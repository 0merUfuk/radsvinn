# Radsvinn Doublecheck

Run adversarial verification before any human gate.

**When to use:** before approving a plan, PR, or merge.

## Steps

1. Spawn four orthogonal passes: Gap Finder, Assumption Attacker, Ground Truth Verifier, Devil's Advocate.
2. Score each pass.
3. Convert to SHIP / FIX / REDESIGN verdict.
4. Re-run only failed passes after fixes.
