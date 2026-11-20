import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPurge } from '../src/index.js';

test('热点对象被分散到不同轮次，避免同时回源', () => {
  const objects = Array.from({ length: 10 }, (_, index) => ({
    id: `hot-${index}`,
    tags: ['promo'],
    ttlSeconds: 30,
    requestsPerSecond: 70, // 预算 80 rps，每轮最多容纳一个热点
  }));
  const plan = planPurge({
    tags: ['promo'],
    objects,
    regions: [{ name: 'us-east', propagationSeconds: 10 }],
    origin: { maxRequestsPerSecond: 100 },
  });

  assert.equal(plan.rounds.length, 10);
  for (const round of plan.rounds) {
    assert.ok(round.predictedOriginRps.purge <= plan.budgetRps);
  }
});

test('单个对象热度超过源站预算时独占一轮并产生告警', () => {
  const plan = planPurge({
    tags: ['promo'],
    objects: [
      { id: 'mega-hot', tags: ['promo'], ttlSeconds: 30, requestsPerSecond: 500 },
      { id: 'normal', tags: ['promo'], ttlSeconds: 30, requestsPerSecond: 10 },
    ],
    regions: [{ name: 'us-east', propagationSeconds: 10 }],
    origin: { maxRequestsPerSecond: 100 },
  });

  const megaRound = plan.rounds.find((round) => round.scope.softInvalidate.includes('mega-hot'));
  assert.equal(megaRound.scope.softInvalidate.length, 1);
  assert.equal(megaRound.predictedOriginRps.withinCapacity, false);
  assert.equal(megaRound.warnings.length, 1);
  assert.match(megaRound.warnings[0], /exceeds origin budget/);
});

test('长 TTL 热点对象进入硬删除范围，短 TTL 对象靠自然过期', () => {
  const plan = planPurge({
    tags: ['promo'],
    objects: [
      { id: 'long-ttl', tags: ['promo'], ttlSeconds: 3600, requestsPerSecond: 1 },
      { id: 'short-ttl', tags: ['promo'], ttlSeconds: 30, requestsPerSecond: 1 },
    ],
    regions: [{ name: 'us-east', propagationSeconds: 10 }],
    origin: { maxRequestsPerSecond: 100 },
    options: { softWindowSeconds: 60 },
  });

  const hardDeleteIds = plan.rounds.flatMap((round) => round.scope.hardDelete.map((entry) => entry.id));
  assert.deepEqual(hardDeleteIds, ['long-ttl']);
});
