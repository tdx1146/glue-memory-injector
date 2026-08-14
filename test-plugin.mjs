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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const {
  buildMemoryContext,
  buildContextText,
  buildSoulText,
  composeContext,
  parseConfidenceTag,
  buildDoubtLayer,
  modulationTier,
  buildModulationConstraint,
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
