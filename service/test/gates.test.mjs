import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gatePlan, gateSkeleton } from '../gates.mjs';
import { resolveCouplingMapPath } from '../coupling-map.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..', '..');
const SKELETON_CHECKS = [
  'acyclic', 'hierarchy_legal', 'order_consistent', 'milestone_shippable',
  'sizing_sane', 'summary_consistency', 'output_language_metadata',
];
const PLAN_CHECKS = [
  'plan_structure', 'hierarchy_legal', 'fields_present', 'single_repo',
  'anchors_exist', 'anchor_consistency', 'zone_routing', 'sizing_bounds',
];

async function withTreecheck(bin, fn) {
  const previous = process.env.RADSVINN_TREECHECK_BIN;
  process.env.RADSVINN_TREECHECK_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.RADSVINN_TREECHECK_BIN;
    else process.env.RADSVINN_TREECHECK_BIN = previous;
  }
}

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function executable(t, stdout, exitCode = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-checker-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'checker');
  fs.writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)}, () => process.exit(${exitCode}));\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function argvCapturingExecutable(t, argvPath, stdout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-checker-argv-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'checker');
  fs.writeFileSync(file, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

function fixtureRunDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-gate-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, 'fixtures', 'e2e-sample', 'skeleton.json'), path.join(dir, 'skeleton.json'));
  fs.copyFileSync(path.join(ROOT, 'fixtures', 'e2e-sample', 'plan.json'), path.join(dir, 'plan.json'));
  return dir;
}

function checks(names, failing) {
  return Object.fromEntries(names.map((name) => [name, { pass: name !== failing }]));
}

function planOutput(itemOverrides = {}, extraItems = {}) {
  const passingItem = {
    ok: true,
    hard_fail: false,
    regen_complaint: '',
    checks: checks(PLAN_CHECKS),
  };
  return {
    ok: true,
    items: {
      i1: itemOverrides.i1 || passingItem,
      i2: itemOverrides.i2 || passingItem,
      i3: itemOverrides.i3 || passingItem,
      ...extraItems,
    },
  };
}

test('treecheck exit 0 fails closed on empty, unparseable, or structurally invalid stdout', async (t) => {
  const runDir = fixtureRunDir(t);
  const cases = [
    ['/usr/bin/true', 'empty stdout'],
    [executable(t, 'not-json\n'), 'unparseable stdout'],
    [executable(t, '{}\n'), 'missing verdict structure'],
  ];

  if (!fs.existsSync('/usr/bin/true')) cases.shift();
  for (const [bin, label] of cases) {
    const result = await withTreecheck(bin, () => gateSkeleton(runDir));
    assert.equal(result.exitCode, 0, label);
    assert.equal(result.ok, false, `${label} must never green-light the gate`);
    assert.match(result.outputError, /without a valid skeleton verdict/);
  }
});

test('/usr/bin/true cannot bypass the real plan gate contract', async (t) => {
  if (!fs.existsSync('/usr/bin/true')) return t.skip('/usr/bin/true is unavailable');
  const runDir = fixtureRunDir(t);
  const result = await withTreecheck('/usr/bin/true', () => gatePlan(runDir, {
    reposRoot: runDir,
  }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, undefined);
  assert.match(result.outputError, /without a valid plan verdict/);
});

test('RADSVINN_SKIP_PLAN_ANCHORS cannot bypass gatePlan outside createServer', async (t) => {
  if (!fs.existsSync('/usr/bin/true')) return t.skip('/usr/bin/true is unavailable');
  const runDir = fixtureRunDir(t);
  const result = await withEnv('RADSVINN_SKIP_PLAN_ANCHORS', '1', () => (
    withTreecheck('/usr/bin/true', () => gatePlan(runDir, { reposRoot: runDir }))
  ));

  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, undefined, 'gatePlan must ignore the legacy environment knob');
  assert.match(result.outputError, /without a valid plan verdict/);
});

test('gatePlan skips only through the explicit whole-gate test seam', async () => {
  const result = await gatePlan('/path/does/not/need/to/exist', { skipPlanGate: true });
  assert.deepEqual(result, { ok: true, skipped: true });
});

test('exit-0 skeleton verdict rejects contradictory and partial check JSON', async (t) => {
  const runDir = fixtureRunDir(t);
  const cases = [
    {
      label: 'contradictory',
      output: {
        ok: true,
        hard_fail: true,
        regen_complaint: 'acyclic failed',
        checks: checks(SKELETON_CHECKS, 'acyclic'),
      },
    },
    {
      label: 'partial arbitrary checks',
      output: {
        ok: true,
        hard_fail: false,
        regen_complaint: '',
        checks: { arbitrary: { pass: true } },
      },
    },
  ];

  for (const { label, output } of cases) {
    const bin = executable(t, `${JSON.stringify(output)}\n`);
    const result = await withTreecheck(bin, () => gateSkeleton(runDir));
    assert.equal(result.exitCode, 0, label);
    assert.equal(result.ok, false, `${label} must fail closed`);
    assert.match(result.outputError, /without a valid skeleton verdict/);
  }
});

test('exit-0 plan verdict rejects contradictory and partial per-item check JSON', async (t) => {
  const runDir = fixtureRunDir(t);
  const cases = [
    {
      label: 'contradictory',
      item: {
        ok: true,
        hard_fail: true,
        regen_complaint: 'anchors failed',
        checks: checks(PLAN_CHECKS, 'anchors_exist'),
      },
    },
    {
      label: 'partial arbitrary checks',
      item: {
        ok: true,
        hard_fail: false,
        regen_complaint: '',
        checks: { arbitrary: { pass: true } },
      },
    },
  ];

  for (const { label, item } of cases) {
    const bin = executable(t, `${JSON.stringify(planOutput({ i1: item }))}\n`);
    const result = await withTreecheck(bin, () => gatePlan(runDir, {
      reposRoot: runDir,
    }));
    assert.equal(result.exitCode, 0, label);
    assert.equal(result.ok, false, `${label} must fail closed`);
    assert.match(result.outputError, /without a valid plan verdict/);
  }
});

test('exit-0 plan verdict keys must exactly match every unique input temp_id', async (t) => {
  const runDir = fixtureRunDir(t);
  const passingItem = planOutput().items.i1;
  const cases = [
    {
      label: 'missing input item verdict',
      output: { ok: true, items: { i1: passingItem, i2: passingItem } },
    },
    {
      label: 'extra unknown item verdict',
      output: planOutput({}, { ghost: passingItem }),
    },
  ];

  for (const { label, output } of cases) {
    const bin = executable(t, `${JSON.stringify(output)}\n`);
    const result = await withTreecheck(bin, () => gatePlan(runDir, { reposRoot: runDir }));
    assert.equal(result.exitCode, 0, label);
    assert.equal(result.ok, false, `${label} must fail closed`);
    assert.match(result.outputError, /without a valid plan verdict/);
  }
});

test('exit-0 plan verdict rejects malformed, empty, or duplicate input identity sets', async (t) => {
  const cases = [
    {
      label: 'malformed plan JSON',
      plan: '{"items":',
    },
    {
      label: 'empty temp_id',
      mutate(plan) {
        plan.items[1].temp_id = '   ';
      },
    },
    {
      label: 'duplicate temp_id',
      mutate(plan) {
        plan.items[1].temp_id = plan.items[0].temp_id;
      },
    },
  ];

  for (const { label, plan, mutate } of cases) {
    const runDir = fixtureRunDir(t);
    if (plan !== undefined) {
      fs.writeFileSync(path.join(runDir, 'plan.json'), plan);
    } else {
      const input = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
      mutate(input);
      fs.writeFileSync(path.join(runDir, 'plan.json'), `${JSON.stringify(input)}\n`);
    }
    const bin = executable(t, `${JSON.stringify(planOutput())}\n`);
    const result = await withTreecheck(bin, () => gatePlan(runDir, { reposRoot: runDir }));
    assert.equal(result.exitCode, 0, label);
    assert.equal(result.ok, false, `${label} must fail closed`);
    assert.match(result.outputError, /without a valid plan verdict/);
  }
});

test('nonzero contract-fail verdict preserves raw checker complaints', async (t) => {
  const runDir = fixtureRunDir(t);
  const contractFail = {
    ok: false,
    hard_fail: true,
    regen_complaint: 'malformed fixture contract',
    checks: {
      contract_valid: { pass: false, complaints: ['malformed fixture contract'] },
    },
  };
  const bin = executable(t, `${JSON.stringify(contractFail)}\n`, 1);

  for (const run of [
    () => gateSkeleton(runDir),
    () => gatePlan(runDir, { reposRoot: runDir }),
  ]) {
    const result = await withTreecheck(bin, run);
    assert.equal(result.exitCode, 1);
    assert.equal(result.ok, false);
    assert.equal(result.outputError, undefined);
    assert.deepEqual(result.raw.checks.contract_valid.complaints, ['malformed fixture contract']);
    assert.equal(result.raw.regen_complaint, 'malformed fixture contract');
  }
});

test('plan gate passes the shared default, relative, and absolute coupling-map path to treecheck', async (t) => {
  const runDir = fixtureRunDir(t);
  const argvPath = path.join(runDir, 'checker-argv.json');
  const passingItem = {
    ok: true,
    hard_fail: false,
    regen_complaint: '',
    checks: checks(PLAN_CHECKS),
  };
  const bin = argvCapturingExecutable(
    t,
    argvPath,
    `${JSON.stringify(planOutput({ i1: passingItem, i2: passingItem, i3: passingItem }))}\n`,
  );
  const absoluteOverride = path.join(runDir, 'absolute-coupling-map.yaml');
  const cases = [
    {
      label: 'default',
      override: undefined,
      expected: path.join(ROOT, 'coupling-map.yaml'),
    },
    {
      label: 'relative override',
      override: path.join('fixtures', 'custom-coupling-map.yaml'),
      expected: path.join(ROOT, 'fixtures', 'custom-coupling-map.yaml'),
    },
    {
      label: 'absolute override',
      override: absoluteOverride,
      expected: absoluteOverride,
    },
  ];

  for (const { label, override, expected } of cases) {
    const result = await withEnv('RADSVINN_COUPLING_MAP', override, () => {
      assert.equal(resolveCouplingMapPath(), expected, `${label} resolver`);
      return withTreecheck(bin, () => gatePlan(runDir, {
        reposRoot: runDir,
      }));
    });
    assert.equal(result.ok, true, label);
    const argv = JSON.parse(fs.readFileSync(argvPath, 'utf8'));
    assert.equal(
      argv.find((arg) => arg.startsWith('-coupling-map=')),
      `-coupling-map=${expected}`,
      `${label} checker argv`,
    );
  }
});

test('plan gate fails closed when the shared coupling map is missing or unreadable', async (t) => {
  const runDir = fixtureRunDir(t);
  const missingMap = path.join(runDir, 'missing-coupling-map.yaml');
  const unreadableMap = path.join(runDir, 'directory-as-coupling-map');
  fs.mkdirSync(unreadableMap);

  for (const mapPath of [missingMap, unreadableMap]) {
    const result = await withEnv('RADSVINN_COUPLING_MAP', mapPath, () => (
      withEnv('RADSVINN_TREECHECK_BIN', undefined, () => gatePlan(runDir, {
        reposRoot: runDir,
      }))
    ));

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    const complaints = Object.values(result.raw.items).flatMap(
      (item) => item.checks.zone_routing.complaints,
    );
    assert.ok(
      complaints.some((complaint) => complaint.includes(`could not load coupling map "${mapPath}"`)),
      `the deterministic zone-routing gate must report the unreadable resolved map ${mapPath}`,
    );
  }
});
