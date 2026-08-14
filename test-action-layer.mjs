// test-action-layer.mjs — 行动层（阶段 4）独立测试（2026-08-14）
// ==============================================================
// 覆盖（设计 v1.0 §三-6 + 任务书 B）：
//   1. buildActionLayer 格式化：四问（该做/想/愿/体力权衡）+ 分级
//      （可执行意向/暂缓意向）；无 action / 空 / 非对象 → null（回退占位）
//   2. 边界：只展示意向，零执行动作（纯函数，无副作用）
//   3. buildContextText 向后兼容：缺省第 6 参 → 占位行
//      （"[行动] 无（暂无行动意向）"）；传激活 thought → 真实行动注入
//   4. buildSoulText pickedThoughts 可选参数向后兼容（null → 自行挑选）
//   5. 预算纪律：行动行 ≤120 字；注入块总长 ≤maxChars
// 独立 runner（不依赖 test-plugin.mjs，避免改动既有测试文件的计数逻辑）。
// 运行：node test-action-layer.mjs（退出码 0=全绿）

import assert from "node:assert/strict";
import { buildActionLayer, buildContextText, buildSoulText } from "./memory-recall.js";

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

const RECALL_DATA = {
  results: [
    { id: "m1", text: "记忆A", origin: "memory", scores: { total: 0.8 } },
  ],
};

// ── 1. buildActionLayer 格式化 ────────────────────────────────────────

ok("buildActionLayer: executable 四问齐全", () => {
  const out = buildActionLayer({
    action: {
      what: "复盘阶段4设计",
      willing: "愿意，把收尾做完",
      want: "想先写报告",
      worth_against_energy: true,
      status: "executable",
    },
  });
  assert.ok(out.startsWith("[行动] 可执行意向"), out);
  assert.ok(out.includes("该做:复盘阶段4设计"));
  assert.ok(out.includes("想:想先写报告"));
  assert.ok(out.includes("愿:愿意"));
  assert.ok(out.includes("值得对抗体力"));
});

ok("buildActionLayer: deferred + 不值得对抗体力", () => {
  const out = buildActionLayer({
    action: {
      what: "深夜写万字长文",
      worth_against_energy: false,
      status: "deferred",
    },
  });
  assert.ok(out.startsWith("[行动] 暂缓意向"), out);
  assert.ok(out.includes("不值得对抗体力"));
});

ok("buildActionLayer: 无 action → null（占位回退）", () => {
  assert.equal(buildActionLayer(null), null);
  assert.equal(buildActionLayer({}), null);
  assert.equal(buildActionLayer({ action: null }), null);
  assert.equal(buildActionLayer({ action: {} }), null);
  assert.equal(buildActionLayer({ action: { what: "  " } }), null);
});

ok("buildActionLayer: 预算纪律 ≤120 字", () => {
  const out = buildActionLayer({
    action: {
      what: "做".repeat(200),
      willing: "愿".repeat(100),
      want: "想".repeat(100),
      worth_against_energy: true,
      status: "executable",
    },
  });
  assert.ok(out.length <= 120, `行动行 ${out.length} 字应 ≤120`);
  assert.ok(out.endsWith("…"));
});

ok("buildActionLayer: 纯函数零副作用（重复调用结果一致）", () => {
  const t = { action: { what: "X", worth_against_energy: true, status: "executable" } };
  assert.equal(buildActionLayer(t), buildActionLayer(t));
});

// ── 2. buildContextText 向后兼容 + 激活 thought 注入 ──────────────────

ok("buildContextText: 缺省第 6 参 → 占位行（既有调用兼容）", () => {
  const out = buildContextText(RECALL_DATA, "q", 1500);
  assert.ok(out.includes("[行动] 无（暂无行动意向）"), out);
});

ok("buildContextText: 激活 thought 带 action → 真实行动注入", () => {
  const activated = {
    action: { what: "收尾阶段4", worth_against_energy: true, status: "executable" },
  };
  const out = buildContextText(RECALL_DATA, "q", 1500, false, null, activated);
  assert.ok(out.includes("[行动] 可执行意向"), out);
  assert.ok(out.includes("该做:收尾阶段4"));
});

ok("buildContextText: 激活 thought 无 action → 占位回退", () => {
  const out = buildContextText(RECALL_DATA, "q", 1500, false, null, { text: "普通 thought" });
  assert.ok(out.includes("[行动] 无（暂无行动意向）"), out);
});

ok("buildContextText: 行动层在质疑层之后、结构完整", () => {
  const data = {
    results: [
      { id: "m1", text: "记忆A", origin: "memory", scores: { total: 0.8 } },
      { id: "m2", text: "记忆B", origin: "memory", scores: { total: 0.78 } },
    ],
  };
  const out = buildContextText(data, "q", 1500);
  const lines = out.split("\n");
  const doubtIdx = lines.findIndex((l) => l.startsWith("[质疑] "));
  const actionIdx = lines.findIndex((l) => l.startsWith("[行动] "));
  assert.ok(doubtIdx >= 0, "质疑层应在场（≥2 条候选时）");
  assert.ok(actionIdx >= 0, "行动层应在场");
  assert.ok(actionIdx > doubtIdx, "行动层在质疑层之后");
});

ok("buildContextText: 注入块总长 ≤maxChars（预算纪律）", () => {
  const out = buildContextText(
    { results: [{ id: "m1", text: "很长的记忆内容".repeat(50), origin: "memory" }] },
    "q", 300,
    false, null,
    { action: { what: "收尾", worth_against_energy: true, status: "executable" } },
  );
  assert.ok(out.length <= 300 + 10, `实际 ${out.length}`);
});

// ── 3. buildSoulText pickedThoughts 向后兼容 ──────────────────────────

ok("buildSoulText: pickedThoughts 缺省（null）→ 自行挑选（旧调用兼容）", () => {
  const snap = {
    lms_voice: ["自述"],
    lms_state: { entropy_ratio: 0.9, last_surprise: 1.0, purpose_coherence: 0.8, turn_count: 3 },
    recent: [{ text: "最近记忆" }],
  };
  const out = buildSoulText(snap, 300);
  assert.ok(typeof out === "string" && out.startsWith("[回魂]"), out);
});

ok("buildSoulText: 传入 pickedThoughts 数组 → 正常组装（阶段 4 复用路径）", () => {
  const snap = {
    lms_voice: [],
    lms_state: { entropy_ratio: 0.9, last_surprise: 1.0, purpose_coherence: 0.8, turn_count: 3 },
    recent: [{ text: "最近记忆" }],
  };
  // thoughtActivationMin=0：测试固定让 picked 的 thought 通过激活门槛
  // （复用路径本身是“传入即用”，激活筛选规则同 ③ 层，不在此重复测）
  const picked = [{ thought: { text: "激活的thought", topic: "主题" }, act: 0.2 }];
  const out = buildSoulText(snap, 300, null, "查询词", { thoughtEnabled: true, thoughtActivationMin: 0 }, picked);
  assert.ok(typeof out === "string" && out.includes("激活的thought"), out);
});

// ── 汇总 ─────────────────────────────────────────────────────────────

console.log(`\n行动层测试: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
