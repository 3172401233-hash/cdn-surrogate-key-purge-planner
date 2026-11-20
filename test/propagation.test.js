import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPurge } from '../src/index.js';

function makeInput(regions) {
  return {
    tags: ['promo'],
    objects: [
      { id: 'a', tags: ['promo'], ttlSeconds: 30, requestsPerSecond: 1 },
      { id: 'b', tags: ['promo'], ttlSeconds: 30, requestsPerSecond: 1 },
    ],
    regions,
    origin: { maxRequestsPerSecond: 100 },
    options: { propagationBudgetSeconds: 120 },
  };
}

test('传播超时的分区被标记为失败区域并给出原因', () => {
  const plan = planPurge(makeInput([
    { name: 'us-east', propagationSeconds: 10 },
    { name: 'ap-south-slow', propagationSeconds: 900 },
  ]));

  assert.equal(plan.failedRegions.length, 1);
  assert.equal(plan.failedRegions[0].name, 'ap-south-slow');
  assert.match(plan.failedRegions[0].reason, /exceeds budget/);
});

test('健康区域按各自传播时间给出完成时刻，失败区域不阻塞轮次', () => {
  const plan = planPurge(makeInput([
    { name: 'us-east', propagationSeconds: 10 },
    { name: 'eu-west', propagationSeconds: 60 },
    { name: 'ap-south-slow', propagationSeconds: 900 },
  ]));

  for (const round of plan.rounds) {
    const byName = new Map(round.regions.map((region) => [region.name, region]));
    assert.equal(byName.get('us-east').status, 'ok');
    assert.equal(byName.get('us-east').completesAtSeconds, round.startAtSeconds + 10);
    assert.equal(byName.get('eu-west').completesAtSeconds, round.startAtSeconds + 60);
    assert.equal(byName.get('ap-south-slow').status, 'failed');
    assert.equal(byName.get('ap-south-slow').completesAtSeconds, null);
  }

  // 轮次时长只取决于健康区域的最大传播时间（60s），不被慢区域拖长
  assert.equal(plan.roundDurationSeconds, 60);
});

test('刷新批次安排在健康区域传播完成之后', () => {
  const plan = planPurge(makeInput([
    { name: 'us-east', propagationSeconds: 10 },
    { name: 'eu-west', propagationSeconds: 60 },
  ]));

  for (const round of plan.rounds) {
    for (const batch of round.refreshBatches) {
      assert.ok(batch.atSeconds >= round.startAtSeconds + 60);
    }
  }
});
