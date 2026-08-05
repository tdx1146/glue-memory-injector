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
const { buildMemoryContext, buildContextText, _resetRateLimitForTest, _getRateLimitStateForTest } =
  await import("./memory-recall.js");

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

// ---- 工具：临时 mock glue server ----
function startMockGlue(results, { fail = false } = {}) {
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
      res.writeHead(200, { "Content-Type": "application/json" });
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
  const { server, port } = await startMockGlue([
    { id: "m1", text: "上次讨论过 Agent OS 总线 Phase 5 计划", origin: "沙漏", system: "sandglass" },
    { id: "m2", text: "用户偏好简洁回复", origin: "LMS", system: "lms" },
  ]);
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
  const { server, port } = await startMockGlue([
    { id: "m1", text: "很长的记忆内容".repeat(50), origin: "沙漏" },
  ]);
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

await okAsync("空查询 / 空结果 → null", async () => {
  _resetRateLimitForTest();
  assert.equal(await buildMemoryContext("   ", {}), null);
  const { server, port } = await startMockGlue([]);
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

console.log("== 2. 真实 glue_server /recall（只读，127.0.0.1:19000）==");
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
if (result) assert.ok(result.prependContext.startsWith("[记忆注入]"));
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
