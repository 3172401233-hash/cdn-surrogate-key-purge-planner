const DEFAULT_OPTIONS = {
  // 源站容量安全系数：每轮回源预测不超过 capacity * safetyMargin
  safetyMargin: 0.8,
  // 相邻两轮清理的最小间隔（秒）
  roundIntervalSeconds: 30,
  // 区域传播时间超过该预算（秒）即判定为失败区域
  propagationBudgetSeconds: 300,
  // 软失效窗口（秒）：TTL 超过该窗口的对象需要硬删除兜底
  softWindowSeconds: 60,
  // 刷新批次之间的间隔（秒）
  refreshBatchIntervalSeconds: 10,
};

function assertFiniteNumber(value, name, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TypeError(`${name} must be a finite number >= ${min}, got ${value}`);
  }
}

function validateInput(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('input must be an object');
  }
  if (!Array.isArray(input.tags) || input.tags.length === 0) {
    throw new TypeError('input.tags must be a non-empty array of tag names');
  }
  if (!Array.isArray(input.objects)) {
    throw new TypeError('input.objects must be an array');
  }
  if (!Array.isArray(input.regions) || input.regions.length === 0) {
    throw new TypeError('input.regions must be a non-empty array');
  }
  if (input.origin === null || typeof input.origin !== 'object') {
    throw new TypeError('input.origin must be an object');
  }
  assertFiniteNumber(input.origin.maxRequestsPerSecond, 'origin.maxRequestsPerSecond', { min: 0.000001 });

  const seenIds = new Set();
  for (const obj of input.objects) {
    if (obj === null || typeof obj !== 'object' || typeof obj.id !== 'string' || obj.id === '') {
      throw new TypeError('each object must have a non-empty string id');
    }
    if (seenIds.has(obj.id)) {
      throw new TypeError(`duplicate object id: ${obj.id}`);
    }
    seenIds.add(obj.id);
    if (!Array.isArray(obj.tags)) {
      throw new TypeError(`object ${obj.id} must have a tags array`);
    }
    assertFiniteNumber(obj.ttlSeconds ?? 0, `object ${obj.id} ttlSeconds`);
    assertFiniteNumber(obj.requestsPerSecond ?? 0, `object ${obj.id} requestsPerSecond`);
  }

  const seenRegions = new Set();
  for (const region of input.regions) {
    if (region === null || typeof region !== 'object' || typeof region.name !== 'string' || region.name === '') {
      throw new TypeError('each region must have a non-empty string name');
    }
    if (seenRegions.has(region.name)) {
      throw new TypeError(`duplicate region name: ${region.name}`);
    }
    seenRegions.add(region.name);
    assertFiniteNumber(region.propagationSeconds, `region ${region.name} propagationSeconds`);
  }
}

/**
 * 规划一次按 surrogate key（标签）的 CDN 清理。
 *
 * 输入：
 *   tags     要清理的标签列表
 *   objects  [{ id, tags, ttlSeconds, requestsPerSecond }]
 *   regions  [{ name, propagationSeconds }]
 *   origin   { maxRequestsPerSecond }
 *   options  见 DEFAULT_OPTIONS
 *
 * 输出每轮清理范围（软失效 / 硬删除 / 分批刷新）、回源预测与失败区域。
 * 纯规划计算，不调用任何 CDN 控制接口。
 */
export function planPurge(input) {
  validateInput(input);
  const options = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) };
  assertFiniteNumber(options.safetyMargin, 'options.safetyMargin', { min: 0.000001 });
  assertFiniteNumber(options.roundIntervalSeconds, 'options.roundIntervalSeconds');
  assertFiniteNumber(options.propagationBudgetSeconds, 'options.propagationBudgetSeconds');
  assertFiniteNumber(options.softWindowSeconds, 'options.softWindowSeconds');
  assertFiniteNumber(options.refreshBatchIntervalSeconds, 'options.refreshBatchIntervalSeconds');

  const budget = input.origin.maxRequestsPerSecond * options.safetyMargin;

  // 1. 选出命中目标标签的对象；同一对象命中多个标签时只清理一次（标签重叠去重）。
  const tagSet = new Set(input.tags);
  const targets = input.objects.filter((obj) => obj.tags.some((tag) => tagSet.has(tag)));

  // 2. 区域健康度：传播时间超过预算的区域判定为失败区域，本轮不再等待它。
  const regions = input.regions.map((region) => ({
    name: region.name,
    propagationSeconds: region.propagationSeconds,
    failed: region.propagationSeconds > options.propagationBudgetSeconds,
  }));
  const healthyRegions = regions.filter((region) => !region.failed);
  const maxPropagationSeconds = healthyRegions.length > 0
    ? Math.max(...healthyRegions.map((region) => region.propagationSeconds))
    : 0;

  // 3. 按热度倒序做贪心装箱：热点对象优先、分散到不同轮次，
  //    每轮回源预测（purge 后全部 miss 的最坏情况）不超过源站预算。
  const sorted = [...targets].sort(
    (a, b) => (b.requestsPerSecond ?? 0) - (a.requestsPerSecond ?? 0),
  );
  const buckets = [];
  for (const obj of sorted) {
    const rps = obj.requestsPerSecond ?? 0;
    const bucket = buckets.find((candidate) => candidate.load + rps <= budget);
    if (bucket) {
      bucket.objects.push(obj);
      bucket.load += rps;
    } else {
      buckets.push({ objects: [obj], load: rps });
    }
  }

  // 4. 轮次时间线：每轮时长至少覆盖健康区域的最大传播时间。
  const roundDuration = Math.max(options.roundIntervalSeconds, maxPropagationSeconds);

  const rounds = buckets.map((bucket, index) => {
    const startAtSeconds = index * roundDuration;
    const propagatedAtSeconds = startAtSeconds + maxPropagationSeconds;

    // 软失效：整轮对象在轮次开始时标记为 stale，配合 stale-while-revalidate 后台回源。
    const softInvalidate = bucket.objects.map((obj) => obj.id);

    // 硬删除：TTL 长于软失效窗口的对象不会及时自然过期，需要硬删除兜底。
    const hardDelete = bucket.objects
      .filter((obj) => (obj.ttlSeconds ?? 0) > options.softWindowSeconds)
      .map((obj) => ({ id: obj.id, atSeconds: startAtSeconds + options.softWindowSeconds }));

    // 分批刷新：传播完成后按热度倒序预热，每批回源预测不超过预算。
    const refreshBatches = [];
    let currentBatch = null;
    for (const obj of bucket.objects) {
      const rps = obj.requestsPerSecond ?? 0;
      if (!currentBatch || currentBatch.predictedRps + rps > budget) {
        currentBatch = { objectIds: [], predictedRps: 0 };
        refreshBatches.push(currentBatch);
      }
      currentBatch.objectIds.push(obj.id);
      currentBatch.predictedRps += rps;
    }
    refreshBatches.forEach((batch, batchIndex) => {
      batch.atSeconds = propagatedAtSeconds + batchIndex * options.refreshBatchIntervalSeconds;
    });

    const refreshPeakRps = refreshBatches.reduce(
      (peak, batch) => Math.max(peak, batch.predictedRps),
      0,
    );

    const warnings = [];
    if (bucket.load > budget) {
      warnings.push(
        `round purge load ${bucket.load.toFixed(2)} rps exceeds origin budget ${budget.toFixed(2)} rps (single hot object cannot be split)`,
      );
    }

    const lastRefreshAt = refreshBatches.length > 0
      ? refreshBatches[refreshBatches.length - 1].atSeconds
      : propagatedAtSeconds;

    return {
      index,
      startAtSeconds,
      endsAtSeconds: Math.max(lastRefreshAt, startAtSeconds + roundDuration),
      scope: {
        softInvalidate,
        hardDelete,
        refresh: refreshBatches.flatMap((batch) => batch.objectIds),
      },
      predictedOriginRps: {
        purge: bucket.load,
        refreshPeak: refreshPeakRps,
        withinCapacity: bucket.load <= budget && refreshPeakRps <= budget,
      },
      regions: regions.map((region) => ({
        name: region.name,
        propagationSeconds: region.propagationSeconds,
        status: region.failed ? 'failed' : 'ok',
        completesAtSeconds: region.failed ? null : startAtSeconds + region.propagationSeconds,
      })),
      refreshBatches,
      warnings,
    };
  });

  const failedRegions = regions
    .filter((region) => region.failed)
    .map((region) => ({
      name: region.name,
      propagationSeconds: region.propagationSeconds,
      reason: `propagation ${region.propagationSeconds}s exceeds budget ${options.propagationBudgetSeconds}s`,
    }));

  return {
    tags: [...tagSet],
    budgetRps: budget,
    roundDurationSeconds: roundDuration,
    totals: {
      targetedObjects: targets.length,
      rounds: rounds.length,
      failedRegions: failedRegions.length,
    },
    failedRegions,
    rounds,
  };
}
