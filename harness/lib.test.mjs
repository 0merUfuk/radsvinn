// lib.test.mjs — focused zero-network regression checks for harness helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAsk } from './lib.mjs';

test('matchAsk: coupled-work terminology surfaces the shared-write no-go zone', () => {
  const matched = matchAsk('Adjust how the account credit balance is written.');

  assert.deepEqual(matched, {
    repos: [],
    zones: ['shared-write'],
  }, 'shared-write asks must surface the coupling zone so the planner routes coupled work needs-human');
});
