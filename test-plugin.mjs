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
let registered = null;
const fakeApi = {
  on(name, handler, opts) { registered = { name, handler, opts }; },
  logger: { warn: (...a) => {} },
};
entry.register(fakeApi);
assert.equal(registered.name, "before_prompt_build");
// 用真实 glue_server（只读）驱动 handler，验证返回结构
const result = await registered.handler(
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
const result2 = await registered.handler(
  { prompt: "x", context: { pluginConfig: { glueUrl: "http://127.0.0.1:1", minIntervalMs: 0 } } },
  {},
);
assert.equal(result2, undefined);
console.log("  ✅ 接线 OK: hook=before_prompt_build, 返回结构正确, fail-open 正确");
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
