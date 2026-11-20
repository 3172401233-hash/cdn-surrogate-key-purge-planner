# cdn-surrogate-key-purge-planner

内容发布后按 surrogate key（标签）规划 CDN 对象清理，避免一次大范围 purge
导致所有边缘节点同时回源、打爆源站。

**本项目只做离线规划与回源预测，不调用任何 CDN 控制接口。**
输出的清理计划（JSON）可以交给运维审核，再由其他系统对接 CDN API 执行。

## 环境

- Node.js >= 24.16.0（`package.json` 的 `engines` 已锁定）
- 无第三方依赖

## 输入

```jsonc
{
  "tags": ["promo-2026"],              // 要清理的 surrogate key
  "objects": [                          // 对象 -> 标签映射 + TTL + 热度
    { "id": "/api/promo", "tags": ["promo-2026"], "ttlSeconds": 300, "requestsPerSecond": 45 }
  ],
  "regions": [                          // 每个区域的 purge 传播时间
    { "name": "us-east", "propagationSeconds": 15 }
  ],
  "origin": { "maxRequestsPerSecond": 200 },  // 源站容量
  "options": {
    "safetyMargin": 0.8,                // 每轮回源预测上限 = 容量 * 安全系数
    "roundIntervalSeconds": 30,         // 相邻轮次最小间隔
    "propagationBudgetSeconds": 300,    // 区域传播超过该预算判定为失败区域
    "softWindowSeconds": 60,            // 软失效窗口，TTL 更长的对象需硬删除兜底
    "refreshBatchIntervalSeconds": 10   // 刷新批次间隔
  }
}
```

同一标签可关联数万对象；同一对象命中多个待清理标签时只清理一次。

## 规划策略

1. **选目标**：按标签命中筛选对象并去重（标签重叠安全）。
2. **分区健康度**：传播时间超过 `propagationBudgetSeconds` 的区域标记为失败区域，
   不再阻塞轮次时间线，单独输出供人工介入。
3. **分轮**：对象按热度倒序贪心装箱，每轮的回源预测
   （purge 后全部 miss 的最坏情况）不超过源站预算，热点对象被分散到不同轮次。
4. **每轮三阶段**：
   - **软失效**：轮次开始将对象标记为 stale，配合 stale-while-revalidate 后台回源；
   - **硬删除**：TTL 长于软失效窗口的对象在窗口结束后硬删除兜底；
   - **分批刷新**：健康区域传播完成后按热度分批预热，每批回源预测同样受预算约束。

## 输出

每轮包含：

- `scope`：本轮软失效 / 硬删除 / 刷新的对象清单；
- `predictedOriginRps`：purge 与刷新峰值的回源预测及是否在容量内；
- `regions`：各区域状态与预计完成时刻；
- `refreshBatches`：刷新批次的时间与对象；
- `warnings`：如单个热点对象自身热度超过预算等无法拆分的情况。

顶层另有 `failedRegions`（失败区域及原因）与 `totals` 汇总。

## 使用

```bash
# 库
node -e "import('./src/index.js').then(({planPurge}) => console.log(planPurge(input)))"

# CLI：读取输入 JSON，输出计划 JSON
node bin/plan.js examples/input.json

# 测试
node --test
```

## 测试覆盖

- `test/tag-overlap.test.js`：标签重叠去重、未命中对象不受影响、数万对象规模；
- `test/propagation.test.js`：慢分区判定失败区域、健康区域完成时刻、刷新时机；
- `test/hot-objects.test.js`：热点对象分轮、超预算热点告警、长 TTL 硬删除；
- `test/origin-rate-limit.test.js`：源站限流下的分轮与刷新批次约束、安全系数、非法输入。
