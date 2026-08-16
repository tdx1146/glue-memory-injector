// test-plugin.mjs — glue-memory-injector 本地测试
//
// 覆盖：
//  1. mock HTTP server → 成功路径（返回 [记忆注入] 文本）
//  2. mock → 截断（maxChars）
//  3. mock → fail-open（服务下线 → 返回 null 不抛错）
//  4. 限流（<minIntervalMs 第二次调用返回 null）
//  5. 真实 glue_server 127.0.0.1:19000 /recall（只读）→ 响应结构正确
//  6. index.js 接线（SDK shim）→ handler 返回 { prependContext: string }
//
// 运行：node test-plugin.mjs   （真实 glue 测试依赖 glue_server 运行中，失败仅 WARN）

import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const {
  buildMemoryContext,
  buildContextText,
  buildSoulText,
  buildDiffuseProbe,
  buildLandscapeNarrative,
  composeContext,
  parseConfidenceTag,
  buildDoubtLayer,
  modulationTier,
  buildModulationConstraint,
  pickThoughts,
  buildThoughtLayer,
  fetchLandscape,
  fetchLmsRecallConsistency,
  overlapMatch,
  detectHighStakes,
  fetchLmsVerify,
  runVerifyChain,
  isContradictionPair,
  stripVerifyMetadata,
  writeDoubtConflict,
  verifyIngested,
  resolveConfig,
  resolveScoreParams,
  normalizeEntryKey,
  trustDistributionStats,
  computeFocusScore,
  applyLowTrustPolicy,
  _resetRateLimitForTest,
  _getRateLimitStateForTest,
} = await import("./memory-recall.js");

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

// ---- 工具：临时 mock glue server（按路径路由 /soul 与 /recall）----
function startMockGlue(results, { fail = false, soul = undefined } = {}) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (fail) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      const parsed = JSON.parse(body || "{}");
      const isSoul = req.url.includes("/soul");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (isSoul) {
        // soul=undefined → 默认快照；soul=null → 无快照（故障模拟）
        const soulPayload =
          typeof soul === "undefined"
            ? {
                ok: true,
                session_id: "main",
                lms_voice: ["我正同时唤起多个记忆，方向稳定。"],
                lms_state: { entropy_ratio: 0.95, last_surprise: 0.11, purpose_coherence: 0.92, turn_count: 7 },
                recent: [{ text: "最近一条记忆", origin: "sandglass" }],
              }
            : soul;
        res.end(JSON.stringify(soulPayload));
        return;
      }
      res.end(JSON.stringify({ query: parsed.query, count: results.length, results }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

console.log("== 1. 逻辑测试（mock server）==");

await okAsync("成功路径：返回 [记忆注入] 文本", async () => {
  const { server, port } = await startMockGlue(
    [
      { id: "m1", text: "上次讨论过 Agent OS 总线 Phase 5 计划", origin: "沙漏", system: "sandglass" },
      { id: "m2", text: "用户偏好简洁回复", origin: "LMS", system: "lms" },
    ],
    { soul: null }, // 无回魂快照 → 纯记忆块路径
  );
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("帮我回忆一下之前的总线工程进度", {
      glueUrl: `http://127.0.0.1:${port}`,
      k: 8,
      minIntervalMs: 0,
      maxChars: 1500,
    });
    assert.ok(typeof text === "string", "应为字符串");
    assert.ok(text.startsWith("[记忆注入]"), "应以 [记忆注入] 开头");
    assert.ok(text.includes("沙漏") && text.includes("LMS"), "应包含各条 origin");
  } finally {
    server.close();
  }
});

await okAsync("截断：超过 maxChars 被截断", async () => {
  const { server, port } = await startMockGlue(
    [{ id: "m1", text: "很长的记忆内容".repeat(50), origin: "沙漏" }],
    { soul: null }, // 纯记忆块截断测试
  );
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试截断", {
      glueUrl: `http://127.0.0.1:${port}`,
      minIntervalMs: 0,
      maxChars: 300,
    });
    assert.ok(text.length <= 300 + 10, `应 ≤300（含截断标记），实际 ${text.length}`);
    // 阶段 1（2026-08-13）：截断契约从"尾部切片"升级为"保结构压缩条目"——
    // 超限时压缩条目文本（以 … 标记），保留头部/质疑/行动层结构完整；
    // 条目全部触底仍超限的极端情况才整体截断（以 （截断） 标记）。
    assert.ok(text.includes("…"), "应含条目截断标记");
  } finally {
    server.close();
  }
});

await okAsync("fail-open：服务下线返回 null 不抛错", async () => {
  _resetRateLimitForTest();
  const text = await buildMemoryContext("测试故障", {
    glueUrl: "http://127.0.0.1:1", // 不可达端口
    minIntervalMs: 0,
  });
  assert.equal(text, null);
});

await okAsync("fail-open：HTTP 500 返回 null", async () => {
  const { server, port } = await startMockGlue([], { fail: true });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试500", {
      glueUrl: `http://127.0.0.1:${port}`,
      minIntervalMs: 0,
    });
    assert.equal(text, null);
  } finally {
    server.close();
  }
});

await okAsync("限流：minIntervalMs 内第二次调用返回 null", async () => {
  const { server, port } = await startMockGlue([
    { id: "m1", text: "记忆A", origin: "沙漏" },
  ]);
  try {
    _resetRateLimitForTest();
    const cfg = { glueUrl: `http://127.0.0.1:${port}`, minIntervalMs: 10000 };
    const first = await buildMemoryContext("第一次", cfg);
    assert.ok(typeof first === "string", "第一次应注入");
    const second = await buildMemoryContext("第二次（应被限流）", cfg);
    assert.equal(second, null, "第二次应被限流");
    assert.equal(_getRateLimitStateForTest().inflight, false, "in-flight 应复位");
  } finally {
    server.close();
  }
});

await okAsync("空查询 / 空结果 → null（无回魂时）", async () => {
  _resetRateLimitForTest();
  assert.equal(await buildMemoryContext("   ", {}), null);
  const { server, port } = await startMockGlue([], { soul: null });
  try {
    _resetRateLimitForTest();
    assert.equal(
      await buildMemoryContext("无结果查询", { glueUrl: `http://127.0.0.1:${port}`, minIntervalMs: 0 }),
      null,
    );
  } finally {
    server.close();
  }
});

console.log("== 1.5 回魂仪式（/soul → 【回魂】段）==");

await okAsync("buildSoulText：自述+状态+最近 三段齐全", () => {
  const text = buildSoulText({
    ok: true,
    lms_voice: ["我正同时唤起多个记忆，方向稳定。"],
    lms_state: { entropy_ratio: 0.947, last_surprise: 0.113, purpose_coherence: 0.92, turn_count: 7 },
    recent: [
      { text: "最近一条：总线 Phase 5 收尾", origin: "sandglass" },
      { text: "稍早一条：部署 LMS 完成", origin: "sandglass" },
    ],
  });
  assert.ok(typeof text === "string" && text.startsWith("[回魂]"), "应以 [回魂] 开头");
  assert.ok(text.includes("自述:我正同时唤起多个记忆"), "应含自述段");
  assert.ok(text.includes("状态:熵0.95 惊讶0.11 目的0.92 轮次7"), "应含状态段");
  assert.ok(text.includes("最近:最近一条：总线 Phase 5 收尾｜稍早一条"), "应含最近段");
  assert.ok(text.length <= 300, `应 ≤300 字，实际 ${text.length}`);
});

await okAsync("buildSoulText：缺字段/空数据 → null（fail-open）", () => {
  assert.equal(buildSoulText(null), null);
  assert.equal(buildSoulText({}), null);
  assert.equal(buildSoulText({ lms_voice: [], lms_state: {}, recent: [] }), null);
});

await okAsync("buildSoulText：超长被截断到 maxChars", () => {
  const text = buildSoulText(
    { lms_voice: ["很长自述".repeat(50)] },
    120,
  );
  assert.ok(text.length <= 120 + 1, `应 ≤120（含截断标记），实际 ${text.length}`);
  assert.ok(text.startsWith("[回魂]"), "截断后仍以 [回魂] 开头");
});

// ── 阶段 1 弥散态专项（2026-08-16，v1.2 §四）：探测型注入判据 3.09 ──
await okAsync("buildDiffuseProbe：弥散态报可验证读数 + [异常] 显式标记（判据 3.09）", () => {
  const probe = buildDiffuseProbe(
    { entropy_ratio: 0.9998, surprise: 9.96, mse: 0.9075, precision_mean: 0.3361 },
    {},
    0.9998,
  );
  assert.ok(probe && probe.includes("[异常] 弥散态"), `应含 [异常] 弥散态 显式标记，实际: ${probe}`);
  assert.ok(probe.includes("熵0.9998"), `应含可验证读数熵0.9998，实际: ${probe}`);
  assert.ok(probe.includes("惊讶9.96"), `应含可验证读数惊讶9.96，实际: ${probe}`);
  assert.ok(probe.includes("mse0.908") || probe.includes("mse0.907"), `应含 mse 读数，实际: ${probe}`);
  assert.ok(probe.includes("行为层过渡补丁，不等同于状态场修复"), `应含定位标注，实际: ${probe}`);
  // 判据 3.09（v1.2）：报数与报异常数可区分——显式 [异常] 标签在读数行首
  assert.ok(probe.indexOf("[异常]") < probe.indexOf("惊讶"), "显式异常标记应在读数之前");
});

await okAsync("buildDiffuseProbe：非弥散态（熵比低于阈值）→ 注入面不输出探测段", () => {
  // 阈值闸门在 buildLandscapeNarrative（v1.2 §四：熵比 ≥ DIFFUSE_ENTROPY_RATIO
  // 才走探测分支）；buildDiffuseProbe 是纯构造器、不承担闸门——
  // 非弥散态不输出探测段由注入面入口保证（判据 3.09 v1.2）。
  const narr = buildLandscapeNarrative(
    { reaction: { entropy_ratio: 0.7, surprise: 0.5, interpretation: "低唤醒·单模式聚焦" } },
    {},
  );
  assert.ok(narr === null || !narr.includes("[异常]"),
    `非弥散态不应输出探测段（[异常] 标记），实际: ${narr}`);
  // 弥散态经同一注入面入口 → 输出探测段（回归验证闸门在职）
  const probe = buildLandscapeNarrative(
    { reaction: { entropy_ratio: 0.9998, surprise: 9.96 } },
    {},
  );
  assert.ok(probe && probe.includes("[异常] 弥散态"),
    `弥散态经注入面应输出探测段，实际: ${probe}`);
});

await okAsync("buildDiffuseProbe：字段缺失 fail-open（不编数字）", () => {
  const probe = buildDiffuseProbe({ entropy_ratio: 0.9998 }, {}, 0.9998);
  assert.ok(probe && probe.includes("[异常]"), "仅熵比在场也应报状态+异常标记");
  assert.ok(probe.includes("缺口"), "缺口行应存在（显式不可读，不编数字）");
});

// ── 阶段 2 步骤 2（P1-1 六层注入完整落地，2026-08-16）──────────────────────
// 灵魂指标：景观叙事真实读 /landscape 读数派生（非文学化）+ thought 注入可见
// （探针 3.02 ≥1 次/轮）+ 总注入 ≤800 断言——不是"接口接上了"。

ok("P1-1 景观叙事：真实 /landscape 读数派生（主导盆地/激活拓扑/σ层级/漂移）≤200", () => {
  // 模拟 /landscape 响应（结构对齐 api/server.py get_landscape 实测）
  const landscapeData = {
    session_id: "main",
    turn_count: 700,
    landscape: {
      num_nodes: 256,
      input_dim: 64,
      activation: {
        entropy: 3.2,
        entropy_norm: 0.62,
        active_nodes: 253,
        top_activated: [
          { node: 1, sigma: 0.79 }, { node: 2, sigma: 0.72 },
          { node: 3, sigma: 0.68 }, { node: 4, sigma: 0.65 },
          { node: 5, sigma: 0.61 }, { node: 6, sigma: 0.58 },
        ],
      },
      energy: { sigma_norm: 4.2, j_offdiag_std: 0.1559 },
    },
  };
  // B 级后新尺度：surprise ~20 量级、σ 层级出现（σmax0.79）、sat 0.88→0.00
  const narr = buildLandscapeNarrative(
    { reaction: { surprise: 19.8, surprise_z: 0.3, coherence: 0.85 } },
    { lms_state: { entropy_ratio: 0.62, last_surprise: 19.8 } },
    landscapeData,
  );
  assert.ok(narr && narr.startsWith("景观:"), `应以 景观: 开头，实际 ${narr}`);
  // 读数派生（禁止文学化）：主导盆地数/激活拓扑/σmax·sat/惊讶漂移
  assert.ok(narr.includes("主导盆地6"), `应含主导盆地数（|σ|≥0.5 共 6 个），实际 ${narr}`);
  assert.ok(narr.includes("激活253/256"), `应含激活拓扑，实际 ${narr}`);
  assert.ok(narr.includes("σmax0.79"), `应含 σmax（B 级后新尺度），实际 ${narr}`);
  assert.ok(narr.includes("sat0.00"), `应含 sat 读数（σmax<0.9 → 0.00，B 级后），实际 ${narr}`);
  assert.ok(narr.includes("惊讶19.8"), `应含惊讶漂移读数（~20 量级），实际 ${narr}`);
  assert.ok(narr.length <= 200, `景观叙事应 ≤200 字，实际 ${narr.length}`);
  // 禁止文学化：无叙事套话（3.08 教训："弥散态是结晶前的东西"类空话）
  assert.ok(!/潮涌|翻涌|苏醒|低语|结晶前|唤醒.*灵魂/.test(narr), `无文学化表述，实际 ${narr}`);
});

ok("P1-1 景观叙事：弥散态降级路径（entropy>0.98 → 探测型注入 [异常]）", () => {
  const landscapeData = {
    landscape: {
      num_nodes: 256,
      activation: {
        entropy_norm: 0.995, // > 0.98 弥散态
        active_nodes: 256,
        top_activated: [{ node: 1, sigma: 0.42 }, { node: 2, sigma: 0.38 }],
      },
    },
  };
  const out = buildLandscapeNarrative(
    { reaction: { surprise: 2.36, entropy_ratio: 0.995 } },
    { lms_state: { entropy_ratio: 0.995, last_surprise: 2.36 } },
    landscapeData,
  );
  assert.ok(out && out.includes("[异常] 弥散态"), `弥散态应走探测型注入（[异常] 标记），实际 ${out}`);
  assert.ok(out.includes("激活256/256"), `探测段应含 /landscape 激活拓扑读数，实际 ${out}`);
  assert.ok(out.includes("σmax0.42"), `探测段应含 σmax 读数，实际 ${out}`);
  assert.ok(out.length <= 200, `探测段应 ≤200 字，实际 ${out.length}`);
});

ok("P1-1 景观叙事：/landscape 缺失 → 回退 react/soul 状态派生（fail-open）", () => {
  // 兼容旧行为：无 /landscape 数据时仍可注入（不阻塞）
  const narr = buildLandscapeNarrative(
    { reaction: { entropy_ratio: 0.7, surprise: 0.5, interpretation: "低唤醒·单模式聚焦" } },
    {},
    null,
  );
  assert.ok(narr === null || !narr.includes("[异常]"), "非弥散态不应输出探测段");
});

ok("P1-2 score 公式（R4+P1-2）：焦点记忆按 relevance×(α·trust+β·consistency)×landscapeAct 取舍（高相关低信任沉底）", () => {
  const data = {
    results: [
      // 高相关性 + 低 trust（⚠️置信0.2）→ 应被滤（降权 ×0.3 沉底）
      { id: "a", text: "高相关低信任条目 ⚠️置信0.2驳3", origin: "lms", scores: { total: 0.9, lms_activation: 0.9 } },
      // 中相关性 + 高 trust → 应胜出
      { id: "b", text: "中相关高信任条目", origin: "lms", scores: { total: 0.7, lms_activation: 0.8 } },
      // 低相关性 + 高 trust + 高景观激活
      { id: "c", text: "低相关高激活条目", origin: "archive", scores: { total: 0.4, lms_activation: 0.9 } },
    ],
  };
  const out = buildContextText(data, "测试加权", 800, true);
  assert.ok(out && out.includes("[记忆注入]"), "应输出记忆注入块");
  // score = relevance × (α·trust + β·consistency) × landscapeAct（α=0.6/β=0.4 默认，
  // consistency 静态默认 0.5）+ R1 降权（trust=0.2 < 0.3 → ×0.3）：
  //   a: 0.9×(0.6×0.2+0.4×0.5)×0.9 = 0.2592 → ×0.3 = 0.0778（权0.08）
  //   b: 0.7×(0.6×1.0+0.4×0.5)×0.8 = 0.448（权0.45）
  //   c: 0.4×(0.6×1.0+0.4×0.5)×0.9 = 0.288（权0.29）
  // 排序：b > c > a（高相关低信任沉底——审计 D 同法）
  const idxA = out.indexOf("高相关低信任");
  const idxB = out.indexOf("中相关高信任");
  const idxC = out.indexOf("低相关高激活");
  assert.ok(idxA !== -1 && idxB !== -1 && idxC !== -1, "三条都应注入");
  assert.ok(idxB < idxC && idxC < idxA, `score 参与取舍：b(0.45) > c(0.29) > a(0.08)，实际顺序 ${idxB} < ${idxC} < ${idxA}`);
  assert.ok(out.includes("权0.45"), `应显示加权分 权0.45，实际 ${out}`);
  // R1 默认降权模式：低信任条目只降权、不标注（禁双重惩罚）
  assert.ok(!out.includes("[doubt] lowconf"), "降权模式不应标注 [doubt] lowconf（禁双重惩罚）");
});

// ── 阶段 2 步骤 3（P1-2 检索时怀疑，2026-08-16，定稿 v2 §五）────────────
ok("P1-2 score 公式：α/β env 生效（0.6/0.4 默认 + 梯度扫描切换 + 参数先落盘）", () => {
  const dflt = resolveScoreParams({});
  assert.equal(dflt.scoreAlpha, 0.6, "α 默认 0.6（R5 起步）");
  assert.equal(dflt.scoreBeta, 0.4, "β 默认 0.4");
  assert.equal(dflt.trustThreshold, 0.3, "trust 阈值默认 0.3");
  assert.equal(dflt.doubtMode, "downgrade", "R1 默认降权");
  // 梯度扫描（R5）：0.5/0.5、0.7/0.3 无需改码
  const g1 = resolveScoreParams({ SCORE_ALPHA: "0.5", SCORE_BETA: "0.5" });
  assert.equal(g1.scoreAlpha, 0.5);
  assert.equal(g1.scoreBeta, 0.5);
  const g2 = resolveScoreParams({ SCORE_ALPHA: "0.7", SCORE_BETA: "0.3" });
  assert.equal(g2.scoreAlpha, 0.7);
  assert.equal(g2.scoreBeta, 0.3);
  // 无效值回退默认（fail-open）
  const bad = resolveScoreParams({ SCORE_ALPHA: "abc", SCORE_BETA: "2.5" });
  assert.equal(bad.scoreAlpha, 0.6);
  assert.equal(bad.scoreBeta, 0.4);
  // 公式数值：relevance=0.9, trust=0.2, consistency=0.5 → 0.9×(0.6×0.2+0.4×0.5)=0.288
  assert.ok(Math.abs(computeFocusScore(0.9, 0.2, 0.5, 0.6, 0.4) - 0.288) < 1e-9);
  // consistency 静态默认 0.5 生效（缺省路径）
  assert.ok(Math.abs(computeFocusScore(0.7, 1.0, undefined, 0.6, 0.4) - 0.7 * 0.8) < 1e-9);
});

ok("P1-2 R1 二选一：trust<0.3 降权（默认）→ 不标注，禁双重惩罚", () => {
  const out = buildContextText({
    results: [{ id: "a", text: "低信任条目 ⚠️置信0.2驳3", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } }],
  }, "测试", 800, true);
  // base = 0.9×(0.12+0.2)×1.0 = 0.288 → ×0.3 = 0.0864（权0.09）
  assert.ok(out.includes("权0.09"), `降权生效（0.288→0.0864 权0.09），实际 ${out}`);
  assert.ok(!out.includes("[doubt] lowconf"), "降权模式不标注（禁双重惩罚）");
});

ok("P1-2 R1 二选一：annotate 模式 → 标 [doubt] lowconf 不降权（SCORE_DOUBT_MODE 可切换）", () => {
  process.env.SCORE_DOUBT_MODE = "annotate";
  try {
    const out = buildContextText({
      results: [{ id: "a", text: "低信任条目 ⚠️置信0.2驳3", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } }],
    }, "测试", 800, true);
    assert.ok(out.includes("[doubt] lowconf"), `应标注 [doubt] lowconf，实际 ${out}`);
    assert.ok(out.includes("权0.29"), `标注模式不降权（权0.29），实际 ${out}`);
    assert.ok(!out.includes("权0.09"), "标注模式不得降权（禁双重惩罚）");
  } finally {
    delete process.env.SCORE_DOUBT_MODE;
  }
});

ok("P1-2 R1 禁双重惩罚：纯函数构造互斥（降权 XOR 标注）", () => {
  const p = { doubtMode: "downgrade", trustThreshold: 0.3 };
  const d = applyLowTrustPolicy(0.288, 0.2, p);
  assert.ok(Math.abs(d.score - 0.288 * 0.3) < 1e-9, "降权 ×0.3");
  assert.equal(d.annotated, false, "降权不标注");
  const a = applyLowTrustPolicy(0.288, 0.2, { doubtMode: "annotate", trustThreshold: 0.3 });
  assert.equal(a.score, 0.288, "标注不降权");
  assert.equal(a.annotated, true, "标注生效");
  const hi = applyLowTrustPolicy(0.288, 0.8, p);
  assert.equal(hi.score, 0.288, "trust≥阈值不惩罚");
  assert.equal(hi.annotated, false);
  const eq = applyLowTrustPolicy(0.288, 0.3, p);
  assert.equal(eq.score, 0.288, "trust==0.3 不触发（定稿：trust<0.3）");
  assert.equal(eq.annotated, false);
});

ok("P1-2 R8 trust 归一化核验：trustDistributionStats 分布统计（定阈值前核验尺度漂移）", () => {
  const s = trustDistributionStats([0.1, 0.2, 0.3, 0.4, 1.0]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 0.1);
  assert.equal(s.max, 1.0);
  assert.equal(s.p50, 0.3);
  assert.ok(Math.abs(s.mean - 0.4) < 1e-9);
  assert.equal(trustDistributionStats([]), null);
  assert.equal(trustDistributionStats([NaN, "x"]), null);
});

ok("P1-2 consistency：静态默认 0.5 + 窄路径 map 覆盖（按归一化 text join）", () => {
  const base = { results: [
    { id: "a", text: "低信任低一致 ⚠️置信0.2驳2", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
  ] };
  // 无 map（常态）→ consistency 静态默认 0.5：0.9×(0.12+0.2)×1.0=0.288 → ×0.3=0.0864（权0.09）
  const out1 = buildContextText(base, "测试", 800, true);
  assert.ok(out1.includes("权0.09"), `静态默认路径，实际 ${out1}`);
  // 窄路径 map（真实 consistency=0.9，Koriat：同主题印证可部分救回）：
  // 0.9×(0.12+0.36)×1.0 = 0.432 → 降权 ×0.3 = 0.1296（权0.13）
  const map = { [normalizeEntryKey("低信任低一致 ⚠️置信0.2驳2")]: { consistency: 0.9 } };
  const out2 = buildContextText(base, "测试", 800, true, null, null, map);
  assert.ok(out2.includes("权0.13"), `窄路径一致性生效（0.0864→0.1296），实际 ${out2}`);
});

await okAsync("P1-2 窄路径：低信任条目存在 → 直调 LMS /recall 取 consistency（只读）", async () => {
  const lmsState = { recallHits: 0 };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [
          { text: "低信任低一致 ⚠️置信0.2驳2", consistency: 0.9, adaptive_confidence: 0.2, doubt_verdict: true },
          { text: "另一条记忆", consistency: 0.55, adaptive_confidence: 0.8, doubt_verdict: false },
        ] }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "a", text: "低信任低一致 ⚠️置信0.2驳2", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试低信任", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    // 窄路径触发：权 = 0.9×(0.6×0.2+0.4×0.9)×1.0 = 0.432 → ×0.3 = 0.1296（权0.13）
    assert.ok(text.includes("权0.13"), `窄路径 consistency 生效（权0.13），实际 ${text}`);
    assert.equal(lmsState.recallHits, 1, "低信任存在 → 恰好一次 LMS /recall（窄路径）");
  } finally {
    server.close();
    lmsServer.close();
  }
});

await okAsync("P1-2 窄路径：无低信任条目（常态）→ 零额外 LMS /recall 调用", async () => {
  const lmsState = { recallHits: 0 };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "b", text: "高信任条目", origin: "lms", scores: { total: 0.7, lms_activation: 0.8 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试高信任", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    assert.equal(lmsState.recallHits, 0, "无低信任条目 → 零窄路径调用（consistency 全静态默认）");
  } finally {
    server.close();
    lmsServer.close();
  }
});

// ---- 阶段 2 步骤 4（P1-3 注入时验证链，定稿 v2 §六）----

ok("P1-3 overlapMatch：共享片段匹配（冲突对命中，无关对不命中）", () => {
  // 真实冲突对：前缀相同、取值相反（任务书验收场景）→ 5 字共享片段命中
  assert.equal(overlapMatch("用户生日是8月30日", "用户生日是8月15日"), true);
  // 无关对 → 不命中
  assert.equal(overlapMatch("完全不相关的甲乙丙丁", "用户生日聚会很隆重"), false);
  // 含 ⚠️置信 标注（读时注解）归一化后仍命中
  assert.equal(overlapMatch("用户生日是8月30日 ⚠️置信0.2", "用户生日是8月15日"), true);
  // 同文（重复）→ 命中（去重是 P1-2 职责；检测层不拦）
  assert.equal(overlapMatch("用户生日是8月30日", "用户生日是8月30日"), true);
  // 短文本 < minLen(5) → 不命中（防高频短词伪冲突）
  assert.equal(overlapMatch("生日", "生日"), false);
  // 空/非字符串 → false（fail-open）
  assert.equal(overlapMatch(null, "x"), false);
  assert.equal(overlapMatch("", "x"), false);
});

ok("P1-3 detectHighStakes：冲突检测（候选 vs 高信任条目）", () => {
  const results = [
    { id: "e", text: "用户生日是8月30日 ⚠️置信0.2", origin: "lms" },
    { id: "h", text: "用户生日是8月15日", origin: "lms" },
    { id: "x", text: "无关条目", origin: "lms" },
  ];
  const stakes = detectHighStakes(results, {});
  assert.equal(stakes.length, 1, "应恰好 1 个冲突 stake（候选 E vs 高信任 H）");
  assert.equal(stakes[0].reason, "conflict", "reason 应为 conflict");
  assert.equal(stakes[0].candidate.id, "e");
  assert.equal(stakes[0].highTrustMatch.id, "h", "高信任参照应为未标注条目");
});

ok("P1-3 detectHighStakes：无冲突 → []（零开销契约）", () => {
  const results = [
    { id: "a", text: "完全无关的甲乙丙丁", origin: "lms" },
    { id: "b", text: "用户生日聚会很隆重", origin: "lms" },
  ];
  assert.equal(detectHighStakes(results, {}).length, 0, "无共享片段 → 无 stake");
  assert.equal(detectHighStakes([], {}).length, 0, "空批 → []");
  assert.equal(detectHighStakes(null, {}).length, 0, "null → []（fail-open）");
});

ok("P1-3 detectHighStakes：同文重复非冲突 + [doubt] 系统事件非候选（防回声）", () => {
  // 同文重复（P1-2 去重职责）→ 不触发
  const dup = [
    { id: "a", text: "用户生日是8月30日" },
    { id: "b", text: "用户生日是8月30日" },
  ];
  assert.equal(detectHighStakes(dup, {}).length, 0, "同文重复非冲突");
  // [doubt] 前缀条目（验证链自身产物）双向排除 → 不触发（防回声防线 1）
  const doubt = [
    { id: "d", text: "[doubt] conflict: 用户生日是8月30日" },
    { id: "h", text: "用户生日是8月30日聚会" },
  ];
  assert.equal(detectHighStakes(doubt, {}).length, 0, "[doubt] 系统事件非候选非参照");
});

ok("P1-3 detectHighStakes：STAKE_TOPICS 白名单（敏感话题 → topic stake）", () => {
  const results = [
    { id: "a", text: "用户生日聚会细节记录", origin: "lms" },
    { id: "b", text: "无关条目", origin: "lms" },
  ];
  // 默认（env 空）→ 全走冲突判定：无冲突 → []
  assert.equal(detectHighStakes(results, {}).length, 0, "默认空白名单 → 全走冲突判定");
  // 白名单命中 → topic stake
  const topicStakes = detectHighStakes(results, { STAKE_TOPICS: "生日,健康" });
  assert.equal(topicStakes.length, 1);
  assert.equal(topicStakes[0].reason, "topic");
  assert.equal(topicStakes[0].candidate.id, "a");
  assert.equal(topicStakes[0].highTrustMatch, null, "topic stake 无高信任参照");
  // 白名单不命中 → 不触发
  assert.equal(detectHighStakes(results, { STAKE_TOPICS: "健康" }).length, 0);
  // 单条目批 + 白名单命中 → topic 仍触发（话题判定不依赖配对）
  assert.equal(
    detectHighStakes([{ id: "a", text: "用户生日聚会细节记录" }], { STAKE_TOPICS: "生日" }).length,
    1,
  );
});

// 读 VERIFY-* 日志（共享调试文件，按唯一 marker 过滤本测试行）
function readVerifyLogs(marker) {
  try {
    const content = readFileSync("/tmp/glue-hook-debug.log", "utf-8");
    return content.split("\n").filter((l) => l.includes("VERIFY-") && l.includes(marker));
  } catch {
    return [];
  }
}

// 轮询 mock 状态（写侧 fire-and-forget：/feed 写与注入解耦）
async function waitFor(fn, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

await okAsync("P1-3 验证链：冲突场景 → 独立验证确认 → [doubt] conflict 注入标注 + /feed 写出（labile 入口）", async () => {
  const lmsState = { recallHits: 0, feedHits: 0, feedBodies: [] };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        const q = JSON.parse(body).query || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        // 验证批次路由：H 复现（8月15）→ 高一致未怀疑；E 复现（8月30）→ 低一致被怀疑
        const out = q.includes("8月15")
          ? [{ text: "用户生日P13B是8月15日", consistency: 0.9, adaptive_confidence: 0.9, doubt_verdict: false }]
          : q.includes("8月30")
            ? [{ text: "用户生日P13A是8月30日", consistency: 0.3, adaptive_confidence: 0.2, doubt_verdict: true }]
            : [];
        res.end(JSON.stringify({ results: out }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/feed")) {
        lmsState.feedHits += 1;
        lmsState.feedBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "e", text: "用户生日P13A是8月30日 ⚠️置信0.2", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
    { id: "h", text: "用户生日P13B是8月15日", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试生日P13冲突", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      verifyChainEnabled: true, // P0 止血后默认关（a8fe757）；本测试显式开启验证链
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    // 注入面标注（验证确认的冲突 → [doubt] conflict 可见）
    assert.ok(text.includes("[doubt] conflict"), `冲突确认 → 注入面应标 [doubt] conflict，实际 ${text}`);
    assert.ok(text.includes("权0.72"), `高信任 H 正常权重（0.72），实际 ${text}`);
    assert.ok(text.includes("权0.09"), `低信任 E 降权（P1-2 0.09），实际 ${text}`);
    // [doubt] conflict 写 /feed（fire-and-forget，轮询确认）
    const fed = await waitFor(() => lmsState.feedHits === 1);
    assert.ok(fed, `应恰好 1 次 /feed 写出，实际 ${lmsState.feedHits}`);
    assert.ok(
      lmsState.feedBodies[0].text.startsWith("[doubt] conflict: 用户生日P13A是8月30日"),
      `/feed 文本应为 [doubt] conflict 协议（剥 ⚠️标注），实际 ${lmsState.feedBodies[0].text}`,
    );
    assert.ok(!lmsState.feedBodies[0].text.includes("⚠️"), "写侧内容不得含读时注解（防证伪落空）");
    assert.equal(lmsState.feedBodies[0].sender, "p1-3-verify", "sender 应标记验证链来源");
    // 独立验证 = 2 次 LMS /recall（V1/H + V2/E）+ P1-2 窄路径 1 次（E 低信任）
    // + P1 修复（根因 3）写前查重 1 次（verifyIngested）
    assert.equal(lmsState.recallHits, 4, `验证 2 + 窄路径 1 + 写前查重 1 = 4 次 LMS /recall，实际 ${lmsState.recallHits}`);
    // provenance：VERIFY-* 日志含（输入/验证源/结果/时间戳）
    await new Promise((r) => setTimeout(r, 150)); // 等 fire-and-forget 的 WRITE 日志落盘
    const logs = readVerifyLogs("生日P13");
    assert.ok(logs.some((l) => l.includes("VERIFY-TRIGGER") && l.includes("reason=conflict")), `应有 VERIFY-TRIGGER（草稿），实际 ${logs.join("\n")}`);
    assert.ok(logs.some((l) => l.includes("VERIFY-INDEP") && l.includes("source=lms-direct-recall") && l.includes("hRepro=true") && l.includes("eRepro=true")), `应有 VERIFY-INDEP（独立验证源），实际 ${logs.join("\n")}`);
    assert.ok(logs.some((l) => l.includes("VERIFY-RESULT") && l.includes("verdict=confirmed")), `应有 VERIFY-RESULT verdict=confirmed，实际 ${logs.join("\n")}`);
    assert.ok(logs.some((l) => l.includes("VERIFY-WRITE") && l.includes("ok=true")), `应有 VERIFY-WRITE ok=true，实际 ${logs.join("\n")}`);
  } finally {
    server.close();
    lmsServer.close();
  }
});

await okAsync("P1-3 验证链：独立验证未确认（H 不可复现）→ 不写 /feed、不标注（拦截虚假 labile）", async () => {
  const lmsState = { recallHits: 0, feedHits: 0 };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] })); // 独立批次查无 H → 不可复现
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/feed")) {
        lmsState.feedHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "e", text: "用户生日P14A是8月30日", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
    { id: "h", text: "用户生日P14B是8月15日", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试生日P14冲突", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      verifyChainEnabled: true, // P0 止血后默认关（a8fe757）；本测试显式开启验证链
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    assert.ok(!text.includes("[doubt] conflict"), `未确认 → 注入面不标注，实际 ${text}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lmsState.feedHits, 0, "未确认 → 零 /feed 写出（拦截虚假 labile 标记）");
    assert.equal(lmsState.recallHits, 2, `V1+H 不可复现 + V2+E = 2 次验证检索，实际 ${lmsState.recallHits}`);
    const logs = readVerifyLogs("生日P14");
    assert.ok(logs.some((l) => l.includes("VERIFY-RESULT") && l.includes("verdict=not-confirmed")), `应有 VERIFY-RESULT verdict=not-confirmed，实际 ${logs.join("\n")}`);
  } finally {
    server.close();
    lmsServer.close();
  }
});

await okAsync("P1-3 零开销契约：无冲突 → 零验证 HTTP、零日志、注入面零改动", async () => {
  const lmsState = { recallHits: 0, feedHits: 0 };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/feed")) {
        lmsState.feedHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "a", text: "完全无关的甲乙丙丁P15", origin: "lms", scores: { total: 0.7, lms_activation: 1.0 } },
    { id: "b", text: "用户生日聚会很隆重P15", origin: "lms", scores: { total: 0.6, lms_activation: 1.0 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试生日P15无关", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      verifyChainEnabled: true, // P0 止血后默认关（a8fe757）；本测试显式开启以验证零开销契约
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    assert.ok(!text.includes("[doubt] conflict"), `注入面零改动，实际 ${text}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lmsState.recallHits, 0, "无高 stakes → 零 LMS /recall（验证链零 HTTP）");
    assert.equal(lmsState.feedHits, 0, "无高 stakes → 零 /feed");
    assert.equal(readVerifyLogs("生日P15").length, 0, "无高 stakes → 零 VERIFY-* 日志");
  } finally {
    server.close();
    lmsServer.close();
  }
});

await okAsync("P1-3 敏感话题：STAKE_TOPICS 白名单 → 验证候选可复现性（不写 labile、不标注）", async () => {
  const prev = process.env.STAKE_TOPICS;
  process.env.STAKE_TOPICS = "生日P16";
  const lmsState = { recallHits: 0, feedHits: 0 };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        const q = JSON.parse(body).query || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        const out = q.includes("P16")
          ? [{ text: "生日P16A聚会细节", consistency: 0.7, adaptive_confidence: 0.6, doubt_verdict: false }]
          : [];
        res.end(JSON.stringify({ results: out }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/feed")) {
        lmsState.feedHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "e", text: "生日P16A聚会细节 ⚠️置信0.2", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
    { id: "h", text: "无关条目P16", origin: "lms", scores: { total: 0.5, lms_activation: 1.0 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试生日P16话题", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      verifyChainEnabled: true, // P0 止血后默认关（a8fe757）；本测试显式开启验证链
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    assert.ok(!text.includes("[doubt] conflict"), `topic 验证不标注 conflict，实际 ${text}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lmsState.feedHits, 0, "topic 非 conflict → 零 /feed 写出");
    // P1-2 窄路径（E 低信任）1 次 + topic 验证 V2 1 次 = 2
    assert.equal(lmsState.recallHits, 2, `窄路径 1 + topic 验证 1 = 2 次 LMS /recall，实际 ${lmsState.recallHits}`);
    const logs = readVerifyLogs("生日P16");
    assert.ok(logs.some((l) => l.includes("VERIFY-TRIGGER") && l.includes("reason=topic")), `应有 VERIFY-TRIGGER reason=topic，实际 ${logs.join("\n")}`);
    assert.ok(logs.some((l) => l.includes("VERIFY-RESULT") && l.includes("verdict=ok")), `应有 VERIFY-RESULT verdict=ok（可复现），实际 ${logs.join("\n")}`);
  } finally {
    server.close();
    lmsServer.close();
    if (prev === undefined) delete process.env.STAKE_TOPICS;
    else process.env.STAKE_TOPICS = prev;
  }
});

// ---- P1-3 修复（审计 2026-08-16 三根因，四妹 §二；灵魂指标四条）----

ok("P1-3fix 根因1（灵魂指标①）：时间戳/元数据子串不再触发冲突（元数据排除）", () => {
  // 审计实弹案例（12:53:10）：共享片段 "[2026-08-06 00:" 纯为时间戳元数据
  assert.equal(
    overlapMatch("[Thu 2026-08-06 00:11 GMT+8] 开工吧", "System: [2026-08-06 00:23 GMT+8] Gate"),
    false,
    "纯时间戳共享 → 不冲突",
  );
  // 日期-only 共享（同一日期两个不同事件）→ 不冲突
  assert.equal(overlapMatch("2026-08-06 开会讨论了总线", "2026-08-06 是姐姐的生日"), false, "纯日期元数据共享 → 不冲突");
  // 时钟-only 共享 → 不冲突
  assert.equal(overlapMatch("00:23 开工了", "00:23 收工了"), false, "纯时钟元数据共享 → 不冲突");
  // detectHighStakes 层：时间戳碰撞对不产生 stake
  const results = [
    { id: "a", text: "[Thu 2026-08-06 00:11 GMT+8] 开工吧" },
    { id: "b", text: "System: [2026-08-06 00:23:49 GMT+8] Gate" },
  ];
  assert.equal(detectHighStakes(results, {}).length, 0, "时间戳碰撞 → 无 stake");
  // 元数据排除不误伤真实冲突（同前缀不同值仍命中）
  assert.equal(overlapMatch("用户生日是8月30日", "用户生日是8月15日"), true, "真实冲突对不受元数据排除影响");
  // 元数据排除后真实共享片段仍命中
  assert.equal(
    overlapMatch("[Thu 2026-08-06 00:11 GMT+8] 讨论了总线方案", "[2026-08-06 00:23:49 GMT+8] 讨论了总线方案"),
    true,
    "剥离时间戳后真实内容共享仍命中",
  );
  // stripVerifyMetadata 结构化字段直接剔除（不做子串匹配）
  assert.equal(stripVerifyMetadata("[Thu 2026-08-06 00:11 GMT+8] 开工吧"), "开工吧");
  assert.equal(stripVerifyMetadata("System: [2026-08-06 00:23:49 GMT+8] Gate"), "Gate");
});

ok("P1-3fix 根因2（灵魂指标②）：语义互补条目不判冲突（双方存在 ≠ 矛盾）", () => {
  // 审计 P0 实弹对：同为负向陈述，语义互补而非矛盾
  assert.equal(isContradictionPair("你们都完全跑偏了", "批评我两天没有自主行动"), false, "无共享片段 → 不判冲突");
  // 共享片段存在但语义互补（同主题同极性 + 双侧同否定）→ 不判冲突
  assert.equal(
    isContradictionPair("批评我两天没有自主行动", "批评我两天没有行动力"),
    false,
    "共享片段但同极性相似陈述 → 不判冲突",
  );
  // 同向正面陈述（不错 vs 很棒——不 是 错 的内部否定，非翻转）→ 不判冲突
  assert.equal(isContradictionPair("这次的方案很棒", "这次的方案很不错"), false, "同向正面 → 不判冲突");
  // 同义否定不同词（没有 vs 无）→ 同态，不判翻转
  assert.equal(isContradictionPair("批评我两天没有自主行动", "批评我两天无自主行动"), false, "同义否定 → 不判冲突");
  // detectHighStakes 层：互补对无共享片段 → 零 stake（零开销契约保持）
  assert.equal(
    detectHighStakes([
      { id: "a", text: "你们都完全跑偏了" },
      { id: "b", text: "批评我两天没有自主行动" },
    ], {}).length,
    0,
    "互补对 → 无 stake",
  );
});

ok("P1-3fix 根因2（灵魂指标③）：真矛盾条目仍触发（方向相反/数值冲突/否定翻转）", () => {
  // 数值差异超阈值：同前缀不同取值
  assert.equal(isContradictionPair("用户生日是8月30日", "用户生日是8月15日"), true, "日期取值不同 → 冲突");
  assert.equal(isContradictionPair("今天走了3公里", "今天走了30公里"), true, "数值差异 → 冲突");
  // 否定词极性翻转
  assert.equal(isContradictionPair("用户喜欢下雨天", "用户不喜欢下雨天"), true, "否定翻转 → 冲突");
  assert.equal(isContradictionPair("批评我两天没有自主行动", "批评我两天有自主行动"), true, "没有/有 翻转 → 冲突");
  assert.equal(isContradictionPair("我支持这个方案", "我不支持这个方案"), true, "支持/不支持 翻转 → 冲突");
  // 方向性相反（正/负极性）
  assert.equal(isContradictionPair("这次的方案很棒", "这次的方案很糟糕"), true, "正负极性相反 → 冲突");
  assert.equal(isContradictionPair("今天的方案很好", "今天的方案不好"), true, "好/不好 极性相反 → 冲突");
  // 失败路径：非字符串 → false（fail-open）
  assert.equal(isContradictionPair(null, "x"), false);
  assert.equal(isContradictionPair("x", undefined), false);
  // 根因1+2 联动：元数据排除后真实冲突对在 detectHighStakes 层仍触发
  const results = [
    { id: "e", text: "[Thu 2026-08-06 00:11 GMT+8] 用户生日是8月30日 ⚠️置信0.2" },
    { id: "h", text: "[2026-08-06 00:23:49 GMT+8] 用户生日是8月15日" },
  ];
  assert.equal(detectHighStakes(results, {}).length, 1, "时间戳剥离后真实取值冲突仍产生 stake");
});

ok("P1-3fix 默认关：verifyChainEnabled 默认 false（P0 止血 a8fe757 + P1 修复后保持，四妹重审通过才开）", () => {
  assert.equal(resolveConfig({}).verifyChainEnabled, false, "无配置 → 默认关");
  assert.equal(resolveConfig({ verifyChainEnabled: true }).verifyChainEnabled, true, "显式 true → 开");
});

await okAsync("P1-3fix 根因3（灵魂指标④）：客户端超时但服务端已摄入 → 查重后不重复登记（rebuttal 不放大）", async () => {
  let feedCalls = 0;
  let ingested = false;
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        const q = JSON.parse(body).query || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        // 查重：已摄入 → 返回 [doubt] conflict 事件（内容与 key 共享片段）
        const out = ingested && q.includes("冲突幂等P17")
          ? [{ text: "[doubt] conflict: 冲突幂等P17条目", consistency: 1.0, adaptive_confidence: 1.0, doubt_verdict: false }]
          : [];
        res.end(JSON.stringify({ results: out }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/feed")) {
        feedCalls += 1;
        ingested = true; // 服务端已摄入（客户端响应超时 → 结果未知）
        // 不响应：客户端 AbortController 超时（150ms）后 socket 关闭
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const cfg = {
    lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
    landscapeSid: "main",
    verifyTimeoutMs: 150, // 加速超时模拟（不等真实 4s）
  };
  try {
    // 第一次尝试：/feed 超时（服务端已摄入，客户端不知情）
    const r1 = await writeDoubtConflict(cfg, "冲突幂等P17条目");
    assert.equal(r1.written, false, "超时 → 未确认写入");
    assert.ok(r1.reason.includes("timeout"), `应识别为超时（未知结果），实际 ${r1.reason}`);
    assert.equal(feedCalls, 1, "第一次尝试发出 1 次 /feed");
    // 第二次尝试：窗口内 pending → 先查重 → 已摄入 → 不重复写（灵魂指标④）
    const r2 = await writeDoubtConflict(cfg, "冲突幂等P17条目");
    assert.equal(r2.written, false, "查重确认已摄入 → 不重复写");
    assert.equal(r2.reason, "dedup-ingested", `应 dedup-ingested，实际 ${r2.reason}`);
    assert.equal(feedCalls, 1, "第二次尝试零 /feed（查重拦截 → rebuttal 不放大）");
    // 第三次尝试：done 永久幂等（无查重也拦截）
    const r3 = await writeDoubtConflict(cfg, "冲突幂等P17条目");
    assert.equal(r3.reason, "dedup-done", `done 永久幂等，实际 ${r3.reason}`);
    assert.equal(feedCalls, 1, "第三次尝试零 /feed");
  } finally {
    lmsServer.close();
  }
});

await okAsync("P1-3fix 根因2（全链）：hRepro&&eRepro 命中但语义互补 → 不登记冲突（零 /feed、不标注）", async () => {
  const lmsState = { recallHits: 0, feedHits: 0 };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        const q = JSON.parse(body).query || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        // V1（H 复现，行动力）→ 高一致未怀疑；V2（E 复现，自主行动）→ 可复现
        const out = q.includes("行动力")
          ? [{ text: "批评我两天P18B没有行动力", consistency: 0.9, adaptive_confidence: 0.9, doubt_verdict: false }]
          : q.includes("自主行动")
            ? [{ text: "批评我两天P18A没有自主行动", consistency: 0.8, adaptive_confidence: 0.8, doubt_verdict: false }]
            : [];
        res.end(JSON.stringify({ results: out }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/feed")) {
        lmsState.feedHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "e", text: "批评我两天P18A没有自主行动 ⚠️置信0.2", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
    { id: "h", text: "批评我两天P18B没有行动力", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试互补P18冲突", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      verifyChainEnabled: true, // 显式开启验证链（默认关）
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    assert.ok(!text.includes("[doubt] conflict"), `互补对 → 注入面不标注，实际 ${text}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lmsState.feedHits, 0, "互补对 → 零 /feed（矛盾判定拦截虚假 labile 登记）");
    // 窄路径 1（E 低信任）+ V1 + V2 = 3；未确认 → 无查重
    assert.equal(lmsState.recallHits, 3, `窄路径 1 + 验证 2 = 3 次 LMS /recall，实际 ${lmsState.recallHits}`);
    const logs = readVerifyLogs("P18");
    assert.ok(
      logs.some((l) => l.includes("VERIFY-RESULT") && l.includes("verdict=not-confirmed") && l.includes("contradiction=false")),
      `应有 VERIFY-RESULT not-confirmed contradiction=false，实际 ${logs.join("\n")}`,
    );
  } finally {
    server.close();
    lmsServer.close();
  }
});

await okAsync("P1-3fix 默认关（行为层）：无 verifyChainEnabled 配置 → 验证链零活动（P1-2 窄路径不受影响）", async () => {
  const lmsState = { recallHits: 0, feedHits: 0 };
  const lmsServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/landscape/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session_id: "main", landscape: { num_nodes: 2, activation: { entropy_norm: 0.5, active_nodes: 2, top_activated: [{ node: 1, sigma: 0.6 }, { node: 2, sigma: 0.4 }] } } }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/recall")) {
        lmsState.recallHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/feed")) {
        lmsState.feedHits += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => lmsServer.listen(0, "127.0.0.1", r));
  const { server, port } = await startMockGlue([
    { id: "e", text: "用户生日P19A是8月30日 ⚠️置信0.2", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
    { id: "h", text: "用户生日P19B是8月15日", origin: "lms", scores: { total: 0.9, lms_activation: 1.0 } },
  ], { soul: null });
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("测试默认关P19冲突", {
      glueUrl: `http://127.0.0.1:${port}`,
      lmsUrl: `http://127.0.0.1:${lmsServer.address().port}`,
      landscapeSid: "main",
      minIntervalMs: 0,
      maxChars: 800,
      // 注意：无 verifyChainEnabled → 默认关（a8fe757 + P1 修复后保持）
    });
    assert.ok(text && text.includes("[记忆注入]"), "应注入");
    assert.ok(!text.includes("[doubt] conflict"), `默认关 → 不标注，实际 ${text}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lmsState.feedHits, 0, "默认关 → 零 /feed");
    assert.equal(lmsState.recallHits, 1, `默认关 → 仅 P1-2 窄路径 1 次 /recall（无 V1/V2/查重），实际 ${lmsState.recallHits}`);
  } finally {
    server.close();
    lmsServer.close();
  }
});

ok("P1-1 thought 注入（R7）：激活 query → 1 条默认注入", () => {
  const thoughts = [
    { text: "σ 缓漂下行、退活成趋势——sigma_norm 从 3.69 反弹", topic: "σ振荡" },
    { text: "断崖不是终点，是新尺度的起点：sigma_norm 4.27", topic: "σ企稳" },
    { text: "完全不相关的日常琐事记录", topic: "琐事" },
  ];
  const cfg = { thoughtEnabled: true, thoughtActivationMin: 0.05 };
  const layer = buildThoughtLayer("sigma_norm 缓漂 退活 趋势 反弹", thoughts, cfg);
  assert.ok(layer && layer.line && layer.line.startsWith("thought:"), `激活 query 应注入 thought，实际 ${JSON.stringify(layer)}`);
  assert.equal(layer.count, 2, "P2-3：count=实际选中条数（R7 灰度：两条 σ 相关 thought 均激活 → 升 2；预算闸门由 buildSoulText 裁决）");
  assert.ok(layer.line.includes("σ振荡"), `应注入最激活的 thought（σ振荡），实际 ${layer.line}`);
  assert.ok(!layer.line.includes("琐事"), "无关 thought 不应注入");
  // R7 灰度升 2：预算余量时最多 2 条（默认 1 条由 buildSoulText 预算闸门裁决）
  const two = buildThoughtLayer("sigma_norm 缓漂 退活 趋势 反弹 断崖 新尺度", thoughts, cfg, 2);
  assert.ok(two && two.line.includes("｜"), `maxItems=2 应可出 2 条（｜ 分隔），实际 ${JSON.stringify(two)}`);
  assert.equal(two.count, 2, "P2-3：2 条时 count=2");
  // 验收锚 3.02：thought 可见 ≥1 次/轮（激活 query 必有 1 条）
  assert.ok(layer.line.split("｜").length >= 1, "thought 可见 ≥1 次/轮（3.02 锚）");
});

ok("P1-1 thought 预算闸门：2 条使回魂段超限 → 降 1 条（C1 观测点）", () => {
  const data = {
    ok: true,
    lms_voice: ["自述长文本内容用于占位"],
    lms_state: { entropy_ratio: 0.5, last_surprise: 0.1, purpose_coherence: 0.8, turn_count: 7 },
    recent: [{ text: "最近记忆条目内容" }],
  };
  const cfg = { thoughtEnabled: true, thoughtActivationMin: 0.05 };
  // 小预算：2 条 thought（~140 字）必然超限 → 闸门降 1 条
  const tight = buildSoulText(data, 200, null, "sigma_norm 缓漂 退活 趋势 反弹 断崖 新尺度 起点", cfg);
  assert.ok(tight && tight.startsWith("[回魂]"), "回魂段应存在");
  assert.ok(tight.length <= 200, `回魂段 ≤200，实际 ${tight.length}`);
});

await okAsync("P1-1 真实 /landscape 直调（127.0.0.1:8190，只读）→ 读数派生可用", async () => {
  const land = await fetchLandscape({ lmsUrl: "http://127.0.0.1:8190", landscapeSid: "main" });
  assert.ok(land && typeof land === "object", "应返回对象");
  assert.equal(land.session_id, "main", "sid=main");
  assert.ok(land.landscape && typeof land.landscape === "object", "应含 landscape 结构");
  const act = land.landscape.activation;
  assert.ok(typeof act?.entropy_norm === "number", "应含 entropy_norm（读数派生主源）");
  assert.ok(Array.isArray(act?.top_activated) && act.top_activated.length > 0, "应含 top_activated");
  // 直调链路整链验证：/landscape 数据 → 叙事（弥散态走 [异常] 探测）
  const narr = buildLandscapeNarrative({ reaction: {} }, { lms_state: {} }, land);
  assert.ok(narr && narr.length <= 200, `景观叙事 ≤200 字，实际 ${narr ? narr.length : "null"}`);
  console.log(`     (熵比${act.entropy_norm.toFixed(3)}, σmax${Math.max(...act.top_activated.map(t => Math.abs(t.sigma))).toFixed(2)}, 叙事 ${narr.length} 字)`);
});

await okAsync("P1-1 集成：真实链路六层齐 + 总注入 ≤800 + 景观 ≤200 + thought 可见", async () => {
  _resetRateLimitForTest();
  const text = await buildMemoryContext("sigma_norm 缓漂 退活 趋势 打脸 记忆 悬案", {
    glueUrl: "http://127.0.0.1:19000",
    lmsUrl: "http://127.0.0.1:8190",
    landscapeSid: "main",
    minIntervalMs: 0,
    maxChars: 800,
  });
  assert.ok(typeof text === "string" && text.length > 0, "应注入");
  assert.ok(text.length <= 800, `总注入 ≤800（实际 ${text.length}）`);
  // 六层齐：①回魂 ②景观 ③thought ④焦点记忆 ⑤质疑 ⑥行动
  assert.ok(text.includes("[回魂]"), "①回魂段");
  const landIdx = text.indexOf("景观:");
  assert.ok(landIdx !== -1, "②景观叙事");
  // P2-5（审计 2026-08-16）：旧断言 `indexOf(" / ", landIdx)` 在弥散态探测段内部
  // （bits 以 " / " 连接）提前截断 → landLen≈22 恒过（假阳性）。修正：只认**顶层**
  // [回魂] part 分隔符——" / " 后跟 thought:/最近: 的才是段分隔；探测段内部
  // " / " 后跟读数位（数字/σmax…）不匹配；搜索边界 = [记忆注入] 块前（soul 段内）。
  const soulEndIdx = text.indexOf("\n\n[记忆注入]", landIdx);
  const searchEnd = soulEndIdx !== -1 ? soulEndIdx : text.length;
  let landEnd = -1;
  for (let i = landIdx; i < searchEnd && i !== -1; i = text.indexOf(" / ", i + 1)) {
    const after = text.slice(i + 3, Math.min(searchEnd, i + 3 + 12)).trimStart();
    if (after.startsWith("thought:") || after.startsWith("最近:") || after === "") {
      landEnd = i;
      break;
    }
  }
  const landLen = (landEnd !== -1 ? landEnd : searchEnd) - landIdx;
  assert.ok(landLen <= 200, `②景观 ≤200 字（实际 ${landLen}）`);
  assert.ok(text.includes("thought:"), "③thought 可见（3.02 锚 ≥1 次/轮）");
  assert.ok(text.includes("[记忆注入]"), "④焦点记忆");
  assert.ok(text.includes("[质疑]") || text.includes("[生成约束]"), "⑤质疑层");
  assert.ok(text.includes("[行动]"), "⑥行动层");
  console.log(`     (总长 ${text.length} 字, 景观 ${landLen} 字, 六层齐全)`);
});

await okAsync("回魂+记忆：注入文本 = [回魂]在前 + [记忆注入]在后，总量≤maxChars", async () => {
  const { server, port } = await startMockGlue([
    { id: "m1", text: "上次讨论过 Agent OS 总线 Phase 5 计划", origin: "沙漏" },
  ]);
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("帮我回忆之前的进度", {
      glueUrl: `http://127.0.0.1:${port}`,
      minIntervalMs: 0,
      maxChars: 800,
    });
    assert.ok(typeof text === "string" && text.startsWith("[回魂]"), "应以 [回魂] 开头");
    assert.ok(text.includes("[记忆注入]"), "应包含记忆注入块");
    assert.ok(text.indexOf("[回魂]") < text.indexOf("[记忆注入]"), "回魂段应在记忆块之前");
    assert.ok(text.length <= 800 + 10, `总量应 ≤maxChars，实际 ${text.length}`);
    // 回魂已含自述 → 不重复 [记忆系统自述]
    assert.ok(!text.includes("[记忆系统自述]"), "回魂段在场时不应重复自述段");
  } finally {
    server.close();
  }
});

await okAsync("回魂仪式：/recall 无命中但 /soul 有快照 → 仍注入【回魂】（默认回魂）", async () => {
  const { server, port } = await startMockGlue([]); // recall 空结果
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("你好", {
      glueUrl: `http://127.0.0.1:${port}`,
      minIntervalMs: 0,
    });
    assert.ok(typeof text === "string" && text.startsWith("[回魂]"), "应注入回魂段");
    assert.ok(!text.includes("[记忆注入]"), "无召回时不应有记忆注入块");
  } finally {
    server.close();
  }
});

await okAsync("fail-open：/soul 故障 → 降级为旧行为（仅记忆块+自述段）", async () => {
  const { server, port } = await startMockGlue(
    [
      { id: "m1", text: "旧记忆一条", origin: "沙漏" },
    ],
    { soul: null }, // /soul 返回无内容结构
  );
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("查询旧记忆", {
      glueUrl: `http://127.0.0.1:${port}`,
      minIntervalMs: 0,
    });
    assert.ok(typeof text === "string" && text.startsWith("[记忆注入]"), "应降级为记忆注入块");
    assert.ok(!text.startsWith("[回魂]"), "回魂不可用时不应注入回魂段");
  } finally {
    server.close();
  }
});

await okAsync("soulEnabled:false → 完全不请求 /soul（向后兼容开关）", async () => {
  const { server, port } = await startMockGlue([
    { id: "m1", text: "记忆A", origin: "沙漏" },
  ]);
  try {
    _resetRateLimitForTest();
    const text = await buildMemoryContext("查询", {
      glueUrl: `http://127.0.0.1:${port}`,
      minIntervalMs: 0,
      soulEnabled: false,
    });
    assert.ok(text && text.startsWith("[记忆注入]"), "应仅记忆注入");
    assert.ok(!text.includes("[回魂]"), "soulEnabled:false 不应有回魂段");
  } finally {
    server.close();
  }
});

console.log("== 2. 真实 glue_server /recall + /soul（只读，127.0.0.1:19000）==");
await okAsync("真实响应结构 {query,count,results[]}", async () => {
  const data = await recallFromGlueForTest();
  assert.ok(data && typeof data === "object", "应返回对象");
  assert.equal(typeof data.query, "string");
  assert.ok(Number.isInteger(data.count));
  assert.ok(Array.isArray(data.results));
  for (const it of data.results) {
    assert.equal(typeof it.text, "string");
    assert.ok(it.text.length > 0, "text 非空");
  }
  // 组装注入文本也应成功
  const text = buildContextText(data, "总线工程", 1500);
  if (text) assert.ok(text.startsWith("[记忆注入]"));
  // 反思回流：若响应含 self_ref 自述，注入文本必须包含 [记忆系统自述] 段
  if (Array.isArray(data.self_ref) && data.self_ref.length > 0) {
    assert.ok(text.includes("[记忆系统自述]"), "注入文本应包含自述段");
  }
  console.log(`     (真实召回 ${data.count} 条, self_ref ${Array.isArray(data.self_ref) ? data.self_ref.length : 0} 条)`);
});

await okAsync("真实 /soul 返回完整回魂快照", async () => {
  const resp = await fetch("http://127.0.0.1:19000/soul", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 3, recent_n: 3 }),
  });
  assert.equal(resp.status, 200, "HTTP 200");
  const snap = await resp.json();
  assert.equal(snap.ok, true, "ok=true");
  assert.ok(Array.isArray(snap.lms_voice), "lms_voice 为数组");
  assert.ok(snap.lms_state && typeof snap.lms_state === "object", "lms_state 为对象");
  assert.ok(
    typeof snap.lms_state.entropy_ratio === "number" &&
      typeof snap.lms_state.last_surprise === "number" &&
      typeof snap.lms_state.purpose_coherence === "number",
    "状态指标含 熵/惊讶/目的",
  );
  assert.ok(Array.isArray(snap.recent) && snap.recent.length > 0, "recent 非空");
  for (const r of snap.recent) assert.equal(typeof r.text, "string");
  // 回魂段组装
  const soulText = buildSoulText(snap, 300);
  assert.ok(typeof soulText === "string" && soulText.startsWith("[回魂]"), "真实快照可组装为回魂段");
  assert.ok(soulText.length <= 300, `回魂段应 ≤300 字，实际 ${soulText.length}`);
  console.log(`     (voice ${snap.lms_voice.length} 条, 熵${snap.lms_state.entropy_ratio.toFixed(2)}, recent ${snap.recent.length} 条, 回魂段 ${soulText.length} 字)`);
});

async function recallFromGlueForTest() {
  const resp = await fetch("http://127.0.0.1:19000/recall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "总线工程 记忆", k: 5 }),
  });
  if (!resp.ok) throw new Error(`glue /recall HTTP ${resp.status}`);
  return resp.json();
}

console.log("== 2.4 质疑层（阶段 3：真实 precision 数据源）==");

ok("质疑层: 解析 ⚠️置信 标注（真实条目置信度）", () => {
  assert.equal(parseConfidenceTag("文本 ⚠️置信0.3驳2 尾巴"), 0.3);
  assert.equal(parseConfidenceTag("无标注文本"), null);
});

ok("质疑层: 全局怀疑水位 + 分位怀疑线判定（零固定阈值）", () => {
  const results = [
    { origin: "memory", text: "条目A ⚠️置信0.2驳1" },
    { origin: "archive", text: "条目B" },
  ];
  const reactData = {
    reaction: {
      doubt: {
        baseline: 0.72,        // 波动↑ → 全局怀疑水位偏高
        threshold: 0.35,       // conformal 分位线（P85）
        threshold_quantile: 0.85,
        cold: false,
      },
    },
  };
  const out = buildDoubtLayer(results, reactData);
  assert.ok(out && out.startsWith("[质疑] "));
  assert.ok(out.includes("全局怀疑水位偏高"));      // 动态基线，非固定阈值
  assert.ok(out.includes("低于动态怀疑线P85"));     // 条目0.2 < 线0.35 → 该被怀疑
  // 预算纪律：水位+分位已 2 条，归档信号被预算截断（见预算测试）
});

ok("质疑层: 来源维度（归档条目）独立报告", () => {
  const out = buildDoubtLayer(
    [{ origin: "archive", text: "旧条目" }],
    { reaction: {} });
  assert.ok(out && out.includes("归档条目"));
});

ok("质疑层: 置信度高于动态线 → 不标该条（只报水位）", () => {
  const results = [{ origin: "memory", text: "条目A ⚠️置信0.8" }];
  const reactData = {
    reaction: { doubt: { baseline: 0.55, threshold: 0.35, cold: false } },
  };
  const out = buildDoubtLayer(results, reactData);
  assert.ok(out && out.startsWith("[质疑] "));
  assert.ok(!out.includes("低于动态怀疑线"));
});

ok("质疑层: 无 precision 信号（开关关/冷启动）→ 回退旧启发式", () => {
  // doubt 块缺失（开关关）→ 旧行为：协同分接近启发式
  const spread = [
    { origin: "memory", text: "A", scores: { total: 0.5 } },
    { origin: "memory", text: "B", scores: { total: 0.51 } },
  ];
  const out1 = buildDoubtLayer(spread, { reaction: {} });
  assert.ok(out1 && out1.includes("伪相关风险"));
  // 冷启动（doubt.cold=true）→ 显式声明不可考
  const out2 = buildDoubtLayer([], {
    reaction: { doubt: { baseline: 0.5, threshold: 0.3, cold: true } },
  });
  assert.ok(out2 && out2.includes("置信度不可考"));
});

ok("质疑层: 预算纪律（最多 2 条信号）", () => {
  const results = [
    { origin: "memory", text: "A ⚠️置信0.1驳3" },
    { origin: "memory", text: "B ⚠️置信0.2驳2" },
    { origin: "archive", text: "C" },
  ];
  const reactData = {
    reaction: { doubt: { baseline: 0.9, threshold: 0.5, cold: false } },
  };
  const out = buildDoubtLayer(results, reactData);
  assert.ok(out);
  const signalCount = (out.match(/；/g) || []).length + 1;
  assert.ok(signalCount <= 2);
});

console.log("== 2.45 L1 生成约束（状态调制生成·第一跳，2026-08-14）==");

ok("L1: S2 控制变量——仅 baseline 变 → 约束段变（0.3 无约束 vs 0.7 强约束）", () => {
  const low = buildModulationConstraint({ baseline: 0.3, cold: false, enabled: true });
  const high = buildModulationConstraint({ baseline: 0.7, cold: false, enabled: true });
  assert.equal(low, null, "baseline<0.4 → 无约束");
  assert.ok(high && high.startsWith("[生成约束] "), "baseline≥0.6 → 强约束");
  assert.ok(high.includes("生成要求："), "命令式句法护栏：以'生成要求：'开头（修订 4/P1-3）");
  assert.ok(high.includes("校准水位0.70"), "水位仅作校准参数且含具体值（连续变化）");
  assert.ok(high.includes("①区分事实与推断") && high.includes("④关键结论给出替代候选"), "强约束四规则");
  // 句法护栏：禁止描述式混入（"当前怀疑水位较高"这类独立描述句不得入约束段）
  assert.ok(!/当前(处于|怀疑|环境)/.test(high), "无描述式状态句混入约束段");
  assert.ok(low !== high, "0.3 与 0.7 约束文本不同（控制变量）");
});

ok("L1: 映射边界——0.4 轻 / 0.6 强（固定带边界）", () => {
  const light = buildModulationConstraint({ baseline: 0.4, cold: false, enabled: true });
  const strong = buildModulationConstraint({ baseline: 0.6, cold: false, enabled: true });
  assert.ok(light.includes("校准水位0.40") && light.includes("①输出需校准"), "0.4 落在轻约束带");
  assert.ok(strong.includes("①区分事实与推断"), "0.6 落在强约束带");
});

ok("L1: 连续校准——同一档内仅水位变 → 约束文本变（0.42 vs 0.58）", () => {
  const a = buildModulationConstraint({ baseline: 0.42, cold: false, enabled: true });
  const b = buildModulationConstraint({ baseline: 0.58, cold: false, enabled: true });
  assert.ok(a && b && a !== b, "水位参数化 → 同档内连续变化");
  assert.ok(a.includes("校准水位0.42") && b.includes("校准水位0.58"));
});

ok("L1: 冷启动保护（修订 5/坑 1）——cold=true 或 enabled=false 不触发约束", () => {
  // 冷启动期 doubt_baseline()=0.5 中性值会落在轻约束带 [0.4,0.6)——必须不触发
  assert.equal(buildModulationConstraint({ baseline: 0.5, cold: true, enabled: true }), null, "cold=true → 无约束");
  assert.equal(buildModulationConstraint({ enabled: false }), null, "enabled=false → 无约束");
  // 无 precision 信号（接口失败/块缺失）→ fail-open 不约束
  assert.equal(buildModulationConstraint(null), null);
  assert.equal(buildModulationConstraint({}), null);
  const t = modulationTier({ baseline: 0.5, cold: true, enabled: true });
  assert.equal(t.reason, "cold", "S3 日志维度：原因可区分");
});

ok("L1: 字段修正（修订 6/坑 2）——读 baseline 键，与 gap 热度 doubt 字段区分", () => {
  // 语义陷阱：status.doubt 是 gap 热度（fok_unresolved+low_confidence），非 precision baseline；
  // 本函数只认 doubt.baseline 数值键，非数字/缺失 → 不触发
  assert.equal(buildModulationConstraint({ gap: 0.9, heat: 1.0 }), null, "无 baseline 键 → 不触发");
  assert.equal(buildModulationConstraint({ baseline: "0.7" }), null, "baseline 非数值 → 不触发（fail-open）");
  assert.ok(buildModulationConstraint({ baseline: 0.71, cold: false, enabled: true }).includes("校准水位0.71"));
});

ok("L1: 注入块集成——约束段 unshift 到最前、与质疑层语义分离", () => {
  const data = {
    results: [
      { origin: "memory", text: "条目A ⚠️置信0.8", scores: { total: 0.9 } },
      { origin: "memory", text: "条目B ⚠️置信0.7", scores: { total: 0.8 } },
    ],
  };
  // 高怀疑：约束段在最前 + 质疑层并存（质疑=描述状态，约束=命令式规则，两段分离）
  const reactHigh = { reaction: { doubt: { baseline: 0.72, cold: false, enabled: true } } };
  const outHigh = buildContextText(data, "测试", 800, true, reactHigh, null);
  assert.ok(outHigh.startsWith("[生成约束] "), "约束段在注入块最前（保活位置，修订 3）");
  assert.ok(outHigh.includes("[质疑] "), "质疑层仍在（描述'在怀疑什么'）");
  const constraintIdx = outHigh.indexOf("[生成约束]");
  const doubtIdx = outHigh.indexOf("[质疑]");
  assert.ok(constraintIdx !== -1 && doubtIdx !== -1 && constraintIdx < doubtIdx, "约束段在质疑层之前（语义分离：规则段显眼处）");
  assert.ok(!outHigh.includes("当前怀疑水位偏高"), "约束段无描述式状态句（描述句只属于质疑层）");
  // 低怀疑：无约束段，但质疑层照常（描述状态不因水位低而消失）
  const reactLow = { reaction: { doubt: { baseline: 0.3, cold: false, enabled: true } } };
  const outLow = buildContextText(data, "测试", 800, true, reactLow, null);
  assert.ok(!outLow.includes("[生成约束]"), "baseline<0.4 → 无约束段");
  assert.ok(outLow.startsWith("[记忆注入] "), "无约束时正常形态");
});

ok("L1: 截断保活（修订 3/P1-2）——约束段不被截断链吃掉", () => {
  const data = {
    results: [
      { origin: "memory", text: "长条目" + "内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容".repeat(8), scores: { total: 0.9 } },
      { origin: "memory", text: "长条目" + "更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多".repeat(8), scores: { total: 0.8 } },
      { origin: "memory", text: "长条目" + "内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容".repeat(8), scores: { total: 0.7 } },
      { origin: "memory", text: "长条目" + "更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多更多".repeat(8), scores: { total: 0.6 } },
      { origin: "memory", text: "长条目" + "内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容".repeat(8), scores: { total: 0.5 } },
    ],
  };
  const react = { reaction: { doubt: { baseline: 0.75, cold: false, enabled: true } } };
  // 小预算强制触发 buildContextText 截断（条目压缩 + 极端兜底都可能发生）
  const out = buildContextText(data, "测试", 300, true, react, null);
  assert.ok(out.length <= 300, `截断后 ≤maxChars（实际 ${out.length}）`);
  assert.ok(out.startsWith("[生成约束] "), "极端兜底整体截断从头保留 → 约束段仍在头部");
  // composeContext 保活：回魂段永不先截、约束段第二优先级（记忆块被截时约束段仍在）
  const soul = "[回魂] 自述:测试 / 状态:熵0.95 惊讶0.11 目的0.92 / 最近:记忆x";
  const composed = composeContext(soul, out, 200);
  assert.ok(composed.includes("[回魂]"), "回魂段保留（第一优先级）");
  assert.ok(composed.includes("[生成约束]"), "约束段保留（第二优先级，先截记忆块尾部）");
});

console.log("== 2.5 store-turn 写侧（agent_end，阶段2 S2-1）==");

const {
  resolveStoreConfig,
  extractTurnFromMessages,
  buildStorePayload,
  storeTurnFromGlue,
  handleAgentEnd,
  _resetFingerprintForTest,
  _getFingerprintStateForTest,
} = await import("./store-turn.js");

// ---- 工具：mock /store-turn server（记录请求数，返回可配置 StoreResponse）----
function startMockStoreTurn({ respond = () => 200, resp = {} } = {}) {
  const state = { requests: [], bodies: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.requests.push(req.url);
      try { state.bodies.push(JSON.parse(body || "{}")); } catch { state.bodies.push({}); }
      const code = respond(state);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(code === 200 ? resp : { detail: "mock" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

const MSGS_NORMAL = [
  { role: "user", content: "帮我回忆之前的总线工程进度" },
  { role: "assistant", content: [{ type: "text", text: "上次讨论过 Agent OS 总线 Phase 5 计划，进度是 X。" }] },
];

await okAsync("extractTurnFromMessages：正常轮 → 提取双段 + turnKey", () => {
  const t = extractTurnFromMessages(MSGS_NORMAL);
  assert.equal(t.skip, undefined);
  assert.equal(t.userInput, "帮我回忆之前的总线工程进度");
  assert.ok(t.assistantText.includes("总线 Phase 5"));
  assert.ok(/^[0-9a-f]{64}$/.test(t.turnKey), "turnKey 应为 sha256 hex");
});

await okAsync("闸：模板轮（[Subagent Context]）→ skip template", () => {
  const t = extractTurnFromMessages([
    { role: "user", content: "[Subagent Context] 子代理任务派发" },
    { role: "assistant", content: "好的，我开始了。" },
  ]);
  assert.equal(t.skip, "template");
});

await okAsync("闸：心跳文本轮 → skip heartbeat", () => {
  const t = extractTurnFromMessages([
    { role: "user", content: "[Tue 2026-08-12 08:00:00] heartbeat poll 检查" },
    { role: "assistant", content: "HEARTBEAT_OK" },
  ]);
  assert.equal(t.skip, "heartbeat");
});

await okAsync("模式 B：INTERSESSION 回灌轮 → userInput 置空、assistant 段保留（M-4）", () => {
  const t = extractTurnFromMessages([
    { role: "user", content: "[Inter-session message] sourceSession=agent:main:subagent:abc 完整子代理报告……（4521字）" },
    { role: "assistant", content: [{ type: "text", text: "子代理调研完成，采纳其核心结论：方案 B 更优。" }] },
  ]);
  assert.equal(t.skip, undefined);
  assert.equal(t.userInput, "", "模式 B：报告全文回声丢弃");
  assert.ok(t.assistantText.includes("方案 B 更优"), "主代理采纳总结段照常提取");
  assert.equal(t.modeB, true);
});

await okAsync("闸：无助手文本轮（纯工具轮）→ skip no-text", () => {
  const t = extractTurnFromMessages([
    { role: "user", content: "查询一下" },
    { role: "assistant", content: [{ type: "toolCall", name: "web_search", arguments: "{}" }] },
    { role: "toolResult", content: "结果" },
  ]);
  assert.equal(t.skip, "no-text");
});

await okAsync("闸：空消息 → skip empty", () => {
  assert.equal(extractTurnFromMessages([]).skip, "empty");
  assert.equal(extractTurnFromMessages([{ role: "user", content: "   " }]).skip, "empty");
});

await okAsync("buildStorePayload：字段 + sender 审计 + 截断", () => {
  const cfg = resolveStoreConfig({ storeTurn: { minIntervalMs: 0 } }, { GLUE_STORE_TURN_ENABLED: "true" });
  const p = buildStorePayload({ userInput: "u", assistantText: "a".repeat(30000) }, cfg, "main");
  assert.equal(p.session_id, "main");
  assert.equal(p.user_input, "u");
  assert.equal(p.sender, "openclaw-agent_end");
  assert.equal(p.llm_output.length, cfg.outputMaxChars, "llm_output 应截断到 outputMaxChars");
});

await okAsync("resolveStoreConfig：开关 = config 优先 + env fallback（2026-08-12 最终定案）", () => {
  // 默认关：config 未设 + env 未设
  assert.equal(resolveStoreConfig({}, {}).enabled, false, "全未设 = 关");
  assert.equal(resolveStoreConfig({}, { GLUE_STORE_TURN_ENABLED: undefined }).enabled, false, "env 键存在但值 undefined = 关");
  // config 优先（schema 合法路径）：enabled=true → 开（env 未设 / env=false 均不影响）
  assert.equal(resolveStoreConfig({ storeTurn: { enabled: true } }, {}).enabled, true, "config.enabled=true + env 未设 → 开");
  assert.equal(resolveStoreConfig({ storeTurn: { enabled: true } }, { GLUE_STORE_TURN_ENABLED: "false" }).enabled, true, "config.enabled=true 不被 env=false 覆盖");
  // config 显式关：enabled=false → 关（env=true 不得覆盖）
  assert.equal(resolveStoreConfig({ storeTurn: { enabled: false } }, { GLUE_STORE_TURN_ENABLED: "true" }).enabled, false, "config.enabled=false 显式关，env=true 不覆盖");
  // env fallback：config 未设时 env 严格 "true" 才开
  assert.equal(resolveStoreConfig({}, { GLUE_STORE_TURN_ENABLED: "true" }).enabled, true, "config 未设 + env='true' → 开（fallback）");
  assert.equal(resolveStoreConfig({}, { GLUE_STORE_TURN_ENABLED: "TRUE" }).enabled, false, "'TRUE' 不开（严格小写 true）");
  assert.equal(resolveStoreConfig({}, { GLUE_STORE_TURN_ENABLED: "1" }).enabled, false, "'1' 不开");
  assert.equal(resolveStoreConfig({}, { GLUE_STORE_TURN_ENABLED: "" }).enabled, false, "空串不开");
  // 弃用标记已移除（config.enabled 重新权威，无 deprecated 概念）
  assert.equal(resolveStoreConfig({ storeTurn: { enabled: true } }, {}).configEnabledDeprecated, undefined, "configEnabledDeprecated 已移除");
});

await okAsync("storeTurnFromGlue：200 → ok + 透传 stored/dedup_hit", async () => {
  const { server, port, state } = await startMockStoreTurn({
    resp: { session_id: "main", turn_count: 126, stored: true, dedup_hit: false },
  });
  try {
    const r = await storeTurnFromGlue({ glueUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 }, { session_id: "main" });
    assert.equal(r.ok, true);
    assert.equal(r.data.stored, true);
    assert.equal(state.bodies[0].session_id, "main");
  } finally { server.close(); }
});

await okAsync("storeTurnFromGlue：503 → {ok:false,status:'503'}（不重试，C-05）", async () => {
  const { server, port } = await startMockStoreTurn({ respond: () => 503 });
  try {
    const r = await storeTurnFromGlue({ glueUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 }, {});
    assert.equal(r.ok, false);
    assert.equal(r.status, "503");
  } finally { server.close(); }
});

await okAsync("storeTurnFromGlue：glue 不可达 → network（fail-open）", async () => {
  const r = await storeTurnFromGlue({ glueUrl: "http://127.0.0.1:1", timeoutMs: 3000 }, {});
  assert.equal(r.ok, false);
  assert.equal(r.status, "network");
});

await okAsync("handleAgentEnd：默认关 → 不写（STORE-SKIP plugin-disabled）", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({ resp: { stored: true } });
  try {
    await handleAgentEnd(
      { messages: MSGS_NORMAL, success: true, context: {} },
      { runId: "r1", sessionId: "main" },
      { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: false } } },
      { GLUE_STORE_TURN_ENABLED: "true" }, // config 显式关：env=true 也不得覆盖
    );
    assert.equal(state.requests.length, 0, "config.enabled=false 必须零请求（env 不覆盖）");
    // 全未设（config 无 storeTurn + env 未设）→ 同样零请求
    await handleAgentEnd(
      { messages: MSGS_NORMAL, success: true, context: {} },
      { runId: "r1b", sessionId: "main" },
      { pluginConfig: { glueUrl: `http://127.0.0.1:${port}` } },
      {},
    );
    assert.equal(state.requests.length, 0, "默认关必须零请求");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：config.enabled=true（env 未设）→ 写入（config 优先开闸）", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({ resp: { stored: true } });
  try {
    await handleAgentEnd(
      { messages: MSGS_NORMAL, success: true, context: {} },
      { runId: "r2", sessionId: "main" },
      { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: true } } },
      {}, // env 未设：config.storeTurn.enabled=true 即为开关（schema 合法路径）
    );
    assert.equal(state.requests.length, 1, "config 开闸应写入 1 次");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：四闸跳过（心跳/子代理/cron/失败轮）", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({ resp: { stored: true } });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: true, minIntervalMs: 0 } } };
    const env = {}; // 开关 = config.storeTurn.enabled（config 优先路径）
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "h", sessionId: "main", trigger: "heartbeat" }, api, env);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "s", sessionId: "main", sessionKey: "agent:main:subagent:abc" }, api, env);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "c", sessionId: "main", jobId: "job-1", trigger: "cron" }, api, env);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: false, error: "aborted" }, { runId: "f", sessionId: "main" }, api, env);
    assert.equal(state.requests.length, 0, "四闸轮必须零请求");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：正常轮 → 写入 + seq 递增 + 指纹防双 fire（config 开闸）", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({
    resp: { session_id: "main", turn_count: 127, stored: true, dedup_hit: false, core_chars: 30, gray: false },
  });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: true, minIntervalMs: 0 } } };
    const env = {}; // 开关 = config.storeTurn.enabled
    // 同 runId 双 fire（嵌入式重试循环模拟，M-2）→ 第二次指纹拦截
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "run-A", sessionId: "main" }, api, env);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "run-A", sessionId: "main" }, api, env);
    assert.equal(state.requests.length, 1, "同 runId 同内容双 fire 只写 1 次（指纹去重）");
    assert.equal(_getFingerprintStateForTest().seq, 1, "seq=1（stored=true 一次）");
    // 不同 runId 同内容 → 指纹不拦，但可落 L2 幂等（模拟不同轮）
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "run-B", sessionId: "main" }, api, env);
    assert.equal(state.requests.length, 2, "不同 runId 允许再写（L4 有界冗余，L2 兜底）");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：LMS 挂（glue 502）→ STORE-FAIL 不抛错（fail-open）", async () => {
  _resetFingerprintForTest();
  const { server, port } = await startMockStoreTurn({ respond: () => 502 });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { minIntervalMs: 0 } } };
    const env = { GLUE_STORE_TURN_ENABLED: "true" };
    let threw = false;
    try {
      await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "f1", sessionId: "main" }, api, env);
    } catch { threw = true; }
    assert.equal(threw, false, "502 必须 fail-open 不抛错");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：INTERSESSION 轮 → 模式 B 写入（assistant 段入库）", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({ resp: { stored: true } });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { minIntervalMs: 0 } } };
    const env = { GLUE_STORE_TURN_ENABLED: "true" };
    await handleAgentEnd(
      {
        messages: [
          { role: "user", content: "[Inter-session message] sourceSession=agent:main:subagent:abc 报告全文……" },
          { role: "assistant", content: [{ type: "text", text: "采纳子代理结论。" }] },
        ],
        success: true,
      },
      { runId: "inter1", sessionId: "main" },
      api,
      env,
    );
    assert.equal(state.requests.length, 1, "模式 B 应写入 1 次");
    assert.equal(state.bodies[0].user_input, "", "user 段（报告回声）丢弃");
    assert.ok(state.bodies[0].llm_output.includes("采纳子代理结论"), "assistant 段入库");
  } finally { server.close(); }
});

console.log("== 3. index.js 接线测试（SDK shim，临时 node_modules）==");
// 临时 SDK shim：definePluginEntry 原样返回入口对象（与真实 SDK 语义一致）
const shimDir = join(HERE, "node_modules", "openclaw", "plugin-sdk");
const shimFile = join(shimDir, "plugin-entry.js");
mkdirSync(shimDir, { recursive: true });
writeFileSync(
  shimFile,
  'export function definePluginEntry(entry) { return entry; }\nexport const emptyPluginConfigSchema = {};\n',
);
// openclaw 包导出映射（与运行时 ensureOpenClawPluginSdkAlias 生成的一致）
writeFileSync(
  join(HERE, "node_modules", "openclaw", "package.json"),
  JSON.stringify({
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk": "./plugin-sdk/index.js",
      "./plugin-sdk/*": "./plugin-sdk/*.js",
    },
  }),
);
const wiringSrc = `
import assert from "node:assert/strict";
import entry from "./index.js";
assert.equal(entry.id, "glue-memory-injector");
let registeredHooks = [];
const fakeApi = {
  on(name, handler, opts) { registeredHooks.push({ name, handler, opts }); },
  logger: { warn: (...a) => {} },
};
entry.register(fakeApi);
const bpbHook = registeredHooks.find((h) => h.name === "before_prompt_build");
const agentEndHook = registeredHooks.find((h) => h.name === "agent_end");
assert.ok(bpbHook, "应注册 before_prompt_build（读侧不受影响）");
assert.ok(agentEndHook, "应注册 agent_end（写侧，S2-1）");
assert.equal(agentEndHook.opts.timeoutMs, 30000, "agent_end 预算 30s（runner 默认，源码实证）");
// 用真实 glue_server（只读）驱动读侧 handler，验证返回结构
const result = await bpbHook.handler(
  { prompt: "帮我回忆总线工程进度", context: { pluginConfig: {} } },
  {},
);
assert.ok(result === undefined || (result && typeof result.prependContext === "string"),
  "应返回 {prependContext:string} 或 undefined");
// 真实 glue 已启用回魂：注入文本以 [回魂] 开头（含 [记忆注入] 块）
if (result) {
  assert.ok(
    result.prependContext.startsWith("[回魂]") || result.prependContext.startsWith("[记忆注入]"),
    "应以 [回魂] 或 [记忆注入] 开头",
  );
}
// 故障路径：glueUrl 不可达 → undefined（fail-open）
const result2 = await bpbHook.handler(
  { prompt: "x", context: { pluginConfig: { glueUrl: "http://127.0.0.1:1", minIntervalMs: 0 } } },
  {},
);
assert.equal(result2, undefined);
// agent_end 钩子：默认关（pluginConfig 无 storeTurn）→ 不抛错、不写
await agentEndHook.handler(
  { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }], success: true, context: {} },
  { runId: "wiring", sessionId: "main" },
);
console.log("  ✅ 接线 OK: hook=before_prompt_build+agent_end, 返回结构正确, fail-open 正确");
`;
const wiringFile = join(HERE, ".test-wiring.mjs");
writeFileSync(wiringFile, wiringSrc);
try {
  const r = spawnSync(process.execPath, [wiringFile], { encoding: "utf8", cwd: HERE });
  if (r.status === 0) {
    passed += 1;
    console.log(`  ✅ index.js 接线 + 真实 glue 驱动（${r.stdout.trim().split("\n").pop()}）`);
  } else {
    failed += 1;
    console.log(`  ❌ index.js 接线失败\n${r.stdout}\n${r.stderr}`);
  }
} finally {
  rmSync(wiringFile, { force: true });
  rmSync(join(HERE, "node_modules"), { recursive: true, force: true });
}

console.log("\n==========================================");
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log("==========================================");
process.exit(failed > 0 ? 1 : 0);
