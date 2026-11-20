import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPurge } from '../src/index.js';

test('总热度远超源站容量时拆分为多轮，每轮回源预测均在预算内', () => {
  // 100 个对象 * 10 rps = 1000 rps，源站预算 100 * 0.8 = 80 rps
  const objects = Array.from({ length: 100 }, (_, index) => ({
    id: `obj-${index}`,
    tags: ['promo'],
    ttlSeconds: 30,
    requestsPerSecond: 10,
  }));
  const plan = planPurge({
    tags: ['promo'],
    objects,
    regions: [{ name: 'us-east', propagationSeconds: 10 }],
    origin: { maxRequestsPerSecond: 100 },
  });

  assert.ok(plan.rounds.length >= 12);
  for (const round of plan.rounds) {
    assert.ok(round.predictedOriginRps.purge <= plan.budgetRps);
    assert.ok(round.predictedOriginRps.refreshPeak <= plan.budgetRps);
    assert.equal(round.predictedOriginRps.withinCapacity, true);
  }
});

test('刷新批次内部的回源预测同样受源站预算约束', () => {
  const objects = Array.from({ length: 8 }, (_, index) => ({
    id: `obj-${index}`,
    tags: ['promo'],
    ttlSeconds: 30,
    requestsPerSecond: 20, // 预算 80，一轮装 4 个，刷新也按每批 <= 80 拆分
  }));
  const plan = planPurge({
    tags: ['promo'],
    objects,
    regions: [{ name: 'us-east', propagationSeconds: 10 }],
    origin: { maxRequestsPerSecond: 100 },
  });

  for (const round of plan.rounds) {
    for (const batch of round.refreshBatches) {
      assert.ok(batch.predictedRps <= plan.budgetRps);
    }
  }
});

test('safetyMargin 决定可用预算', () => {
  const input = {
    tags: ['promo'],
    objects: [{ id: 'a', tags: ['promo'], ttlSeconds: 30, requestsPerSecond: 60 }],
    regions: [{ name: 'us-east', propagationSeconds: 10 }],
    origin: { maxRequestsPerSecond: 100 },
  };

  const loose = planPurge({ ...input, options: { safetyMargin: 0.8 } });
  assert.equal(loose.rounds[0].predictedOriginRps.withinCapacity, true);

  const strict = planPurge({ ...input, options: { safetyMargin: 0.5 } });
  assert.equal(strict.rounds[0].predictedOriginRps.withinCapacity, false);
});

test('非法输入直接抛错', () => {
  assert.throws(() => planPurge(null), /input must be an object/);
  assert.throws(
    () => planPurge({ tags: [], objects: [], regions: [{}], origin: { maxRequestsPerSecond: 1 } }),
    /tags must be a non-empty array/,
  );
  assert.throws(
    () => planPurge({
      tags: ['t'],
      objects: [{ id: 'x', tags: ['t'] }, { id: 'x', tags: ['t'] }],
      regions: [{ name: 'r', propagationSeconds: 1 }],
      origin: { maxRequestsPerSecond: 1 },
    }),
    /duplicate object id/,
  );
});
