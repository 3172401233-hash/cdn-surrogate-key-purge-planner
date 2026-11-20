import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPurge } from '../src/index.js';

const baseInput = {
  tags: ['promo', 'user:42'],
  objects: [
    { id: 'a', tags: ['promo'], ttlSeconds: 30, requestsPerSecond: 1 },
    { id: 'b', tags: ['user:42'], ttlSeconds: 30, requestsPerSecond: 1 },
    // 同时命中两个待清理标签，只能被清理一次
    { id: 'overlap', tags: ['promo', 'user:42'], ttlSeconds: 30, requestsPerSecond: 1 },
    { id: 'untouched', tags: ['other'], ttlSeconds: 30, requestsPerSecond: 1 },
  ],
  regions: [{ name: 'us-east', propagationSeconds: 10 }],
  origin: { maxRequestsPerSecond: 100 },
};

test('标签重叠的对象在所有轮次中只出现一次', () => {
  const plan = planPurge(baseInput);
  const purgedIds = plan.rounds.flatMap((round) => round.scope.softInvalidate);

  assert.equal(purgedIds.filter((id) => id === 'overlap').length, 1);
  assert.deepEqual([...purgedIds].sort(), ['a', 'b', 'overlap']);
  assert.equal(plan.totals.targetedObjects, 3);
});

test('未命中标签的对象不进入清理范围', () => {
  const plan = planPurge(baseInput);
  const allScopes = plan.rounds.flatMap((round) => [
    ...round.scope.softInvalidate,
    ...round.scope.hardDelete.map((entry) => entry.id),
    ...round.scope.refresh,
  ]);

  assert.ok(!allScopes.includes('untouched'));
});

test('清理数万个同标签对象时可以正常规划', () => {
  const objects = Array.from({ length: 50_000 }, (_, index) => ({
    id: `obj-${index}`,
    tags: ['bulk'],
    ttlSeconds: 30,
    requestsPerSecond: 0.001,
  }));
  const plan = planPurge({
    tags: ['bulk'],
    objects,
    regions: [{ name: 'us-east', propagationSeconds: 10 }],
    origin: { maxRequestsPerSecond: 100 },
  });

  assert.equal(plan.totals.targetedObjects, 50_000);
  const purged = plan.rounds.flatMap((round) => round.scope.softInvalidate);
  assert.equal(new Set(purged).size, 50_000);
});
