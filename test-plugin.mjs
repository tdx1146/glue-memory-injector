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
    assert.ok(text.endsWith("（截断）"), "应以截断标记结尾");
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
  const cfg = resolveStoreConfig({ storeTurn: { enabled: true } });
  const p = buildStorePayload({ userInput: "u", assistantText: "a".repeat(30000) }, cfg, "main");
  assert.equal(p.session_id, "main");
  assert.equal(p.user_input, "u");
  assert.equal(p.sender, "openclaw-agent_end");
  assert.equal(p.llm_output.length, cfg.outputMaxChars, "llm_output 应截断到 outputMaxChars");
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
    );
    assert.equal(state.requests.length, 0, "默认关必须零请求");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：四闸跳过（心跳/子代理/cron/失败轮）", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({ resp: { stored: true } });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: true, minIntervalMs: 0 } } };
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "h", sessionId: "main", trigger: "heartbeat" }, api);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "s", sessionId: "main", sessionKey: "agent:main:subagent:abc" }, api);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "c", sessionId: "main", jobId: "job-1", trigger: "cron" }, api);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: false, error: "aborted" }, { runId: "f", sessionId: "main" }, api);
    assert.equal(state.requests.length, 0, "四闸轮必须零请求");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：正常轮 → 写入 + seq 递增 + 指纹防双 fire", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({
    resp: { session_id: "main", turn_count: 127, stored: true, dedup_hit: false, core_chars: 30, gray: false },
  });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: true, minIntervalMs: 0 } } };
    // 同 runId 双 fire（嵌入式重试循环模拟，M-2）→ 第二次指纹拦截
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "run-A", sessionId: "main" }, api);
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "run-A", sessionId: "main" }, api);
    assert.equal(state.requests.length, 1, "同 runId 同内容双 fire 只写 1 次（指纹去重）");
    assert.equal(_getFingerprintStateForTest().seq, 1, "seq=1（stored=true 一次）");
    // 不同 runId 同内容 → 指纹不拦，但可落 L2 幂等（模拟不同轮）
    await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "run-B", sessionId: "main" }, api);
    assert.equal(state.requests.length, 2, "不同 runId 允许再写（L4 有界冗余，L2 兜底）");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：LMS 挂（glue 502）→ STORE-FAIL 不抛错（fail-open）", async () => {
  _resetFingerprintForTest();
  const { server, port } = await startMockStoreTurn({ respond: () => 502 });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: true, minIntervalMs: 0 } } };
    let threw = false;
    try {
      await handleAgentEnd({ messages: MSGS_NORMAL, success: true }, { runId: "f1", sessionId: "main" }, api);
    } catch { threw = true; }
    assert.equal(threw, false, "502 必须 fail-open 不抛错");
  } finally { server.close(); }
});

await okAsync("handleAgentEnd：INTERSESSION 轮 → 模式 B 写入（assistant 段入库）", async () => {
  _resetFingerprintForTest();
  const { server, port, state } = await startMockStoreTurn({ resp: { stored: true } });
  try {
    const api = { pluginConfig: { glueUrl: `http://127.0.0.1:${port}`, storeTurn: { enabled: true, minIntervalMs: 0 } } };
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
