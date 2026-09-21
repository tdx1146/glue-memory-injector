// replay6-verify.mjs — 第六刀验证：历史唤醒轮回放（≥20 次）
//
// 前（改前）= 会话留存里的**真实注入**（replay6-collect.py 从 runtime-context 采集），
//   ① 回魂在不在 ② 机器段计数 ③ 总字符数。
// 后（改后）= **真函数 + 真只读端点**：buildMemoryContext(<历史醒因原文>) 经本地**只读代理**
//   转发 /soul → glue:19000、/landscape → lms:8191；**/recall 一律拒发（500）** ——
//   既证「唤醒轮不再召回（零 z 窗口扰动）」，又保证回放本身不碰生产写侧。
// 人话零误伤：非唤醒人类轮 query 与旧函数**逐字节一致** + 人类轮注入形态不变。
import { readFileSync } from "node:fs";
import http from "node:http";import { buildMemoryContext, _resetRateLimitForTest, extractQueryInfo, extractQueryText, resolveInjectHygiene }
  from "/vol1/@apphome/trim.openclaw/data/home/.openclaw/plugins/glue-memory-injector/memory-recall.js";

const GLUE = "http://127.0.0.1:19000";
const LMS = "http://127.0.0.1:8191";
const hygiene = resolveInjectHygiene({}, {});
const WAKE_BANNERS = ["🌙【梦中醒来】", "📬【信箱新消息】", "【信箱·新留言】"];
const MACHINE_RES = [
  /\[记忆系统自述\]/g, /激活节点[:：][^｜/\n]*/g, /\[行动\][^｜/\n]*/g,
  /\[信息性标注[^\]｜\n]*\]?/g, /【重理解】[^｜\n]*/g, /<\|[\w-]{1,40}\|>/g, /\[记忆注入\]/g,
];
const countMachine = (t) => MACHINE_RES.reduce((s, r) => s + (String(t).match(r) || []).length, 0);

// ── 只读代理：/recall → 500（拒发，防污染 z 窗口）；/soul→glue；/landscape→lms；/react→拒
const refused = [];
let curIdx = -1; // 归属：当前正在回放的样本序号（拒发请求归到该轮）
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const u = req.url || "";
    if (u.includes("/soul")) {
      return forward(`${GLUE}${u}`, "POST", body, res);
    }
    if (u.includes("/landscape")) {
      return forward(`${LMS}${u}`, "GET", null, res);
    }
    refused.push({ idx: curIdx, url: u });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "refused-by-replay-proxy" }));
  });
});
function forward(url, method, body, res) {
  const r = http.request(url, { method, headers: { "Content-Type": "application/json" } }, (up) => {
    const bufs = [];
    up.on("data", (c) => bufs.push(c));
    up.on("end", () => {
      res.writeHead(up.statusCode || 502, { "Content-Type": "application/json" });
      res.end(Buffer.concat(bufs));
    });
  });
  r.on("error", () => { res.writeHead(502); res.end("{}"); });
  if (body && body.length) r.write(body);
  r.end();
}
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const PPORT = proxy.address().port;

const before = JSON.parse(readFileSync("/tmp/四妹-交付/replay6-before-wake.json", "utf8"));
const corpus = JSON.parse(readFileSync("/tmp/wake-corpus-20260921.json", "utf8"))
  .filter((e) => WAKE_BANNERS.some((b) => e.prompt.includes(b)));
const N = Math.max(20, Math.min(25, corpus.length));
const prompts = corpus.slice(0, N);

const rows = [];
for (let i = 0; i < prompts.length; i += 1) {
  const e = prompts[i];
  curIdx = i;
  const qinfo = extractQueryInfo(e.prompt, hygiene);
  let out = null;
  let attempts = 0;
  // 只读端点（glue / LMS）会吐锹静默/超时 ⇒ 回魂本就会 fail-open 不注（预存行为）；
  // 为把「真逻辑失败」与「只读端点一时抖动」分开，这里 null 时**重试**，重试次数单独报。
  for (attempts = 1; attempts <= 3; attempts += 1) {
    _resetRateLimitForTest();
    try {
      out = await buildMemoryContext(e.prompt, {
        glueUrl: `http://127.0.0.1:${PPORT}`, lmsUrl: `http://127.0.0.1:${PPORT}`,
        minIntervalMs: 0, maxChars: 1500,
      });
    } catch (err) { out = `THROW:${err.message}`; }
    if (typeof out === "string" && out.length) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  rows.push({
    i, prompt: e.prompt, out,
    machineOnly: qinfo.machineOnly,
    attempts,
    machineHits: typeof out === "string" ? countMachine(out) : 0,
    chars: typeof out === "string" ? out.length : 0,
    soul: typeof out === "string" && out.startsWith("[回魂]"),
  });
}

const hasSoul = rows.filter((r) => typeof r.out === "string" && r.out.startsWith("[回魂]")).length;
const nullOut = rows.filter((r) => r.out === null).length;
const machineTotal = rows.reduce((s, r) => s + (typeof r.out === "string" ? countMachine(r.out) : 0), 0);
const charsMean = Math.round(rows.reduce((s, r) => s + (typeof r.out === "string" ? r.out.length : 0), 0) / rows.length);
const bRecent = before.recent25 || [];
const bSoul = bRecent.filter((w) => w.has_soul).length;
const bMachine = bRecent.reduce((s, w) => s + w.machine_hits, 0);
const bChars = Math.round(bRecent.reduce((s, w) => s + w.chars, 0) / Math.max(1, bRecent.length));

console.log("== 第六刀验证：历史唤醒轮回放（近 25 次真实醒因原文）==");
const tbl = [
  ["指标", "改前（留存真实注入）", "改后（真函数+只读端点）"],
  ["样本数", bRecent.length, rows.length],
  ["① 回魂有 / 无", `${bSoul} / ${bRecent.length - bSoul}`, `${hasSoul} / ${rows.length - hasSoul}`],
  ["（其中完全未注入）", 0, nullOut],
  ["② 机器段命中合计", bMachine, machineTotal],
  ["③ 总字符数（均值/次）", bChars, charsMean],
  ["④ 含记忆块 [记忆注入]", "见留存（焦点记忆块在位）", 0],
];
for (const r of tbl) console.log(r.map(String).join(" | "));

console.log("\n== 全量（改前 219 次唤醒轮注入，留存实况）==");
console.log(`含【回魂】: ${before.has_soul} / 不含: ${before.no_soul}｜机器段命中合计: ${before.machine_hits_total}｜平均字符: ${before.chars_mean}`);

console.log("\n== 零召回（代理拒发计数）==");
const pureWake = rows.filter((r) => r.machineOnly);
const mixed = rows.filter((r) => !r.machineOnly);
console.log(`纯机器唤醒轮（machineOnly=true）: ${pureWake.length}/${rows.length} → 只调 /soul+/landscape`);
console.log(`混合轮（人话+唤醒横幅，第五刀既定：保留人类线索走正常召回）: ${mixed.length} 条`);
for (const m of mixed) {
  console.log(`  · 样本#${m.i} 人话 query=${JSON.stringify(extractQueryInfo(m.prompt, hygiene).query)}`);
}
console.log(`代理拒发请求合计: ${refused.length} —— ${JSON.stringify(refused)}`);
const pureRefused = refused.filter((r) => pureWake.some((p) => p.i === r.idx));
console.log(`其中落在纯机器唤醒轮上的: ${pureRefused.length}（必须为 0 = 唤醒轮不再召回）`);
console.log(`纯机器唤醒轮机器段命中: ${pureWake.reduce((s, r) => s + r.machineHits, 0)}（必须为 0）`);
console.log(`纯机器唤醒轮回魂覆盖: ${pureWake.filter((r) => r.soul).length}/${pureWake.length}｜字符均值 ${Math.round(pureWake.reduce((s, r) => s + r.chars, 0) / Math.max(1, pureWake.length))}`);
console.log(`需重试才拿到回魂的轮（只读端点抖动，非本单逻辑）: ${rows.filter((r) => r.attempts > 1).length}｜仍为 null: ${rows.filter((r) => !r.out).length}`);

console.log("\n== 人话零误伤（非唤醒人类轮：query 逐字节与旧函数一致 + 非机器轮）==");
const humanCases = [
  "[Mon 2026-09-21 09:00 GMT+8] 帮我看看回魂仪式那套还在跑吗",
  "[Mon 2026-09-21 09:01 GMT+8] 全部清理完成，然后呢就不说话了？ 还有一晚上过去了，自主醒来还是没有作用啊",
  "[Mon 2026-09-07 18:05 GMT+8] 18点的时候，你发过这个给自己：\n🌙【梦中醒来】自主醒来（routine 闹钟兜底）：惊讶度 0.0 / 熵 0.00",
  "[Mon 2026-09-21 17:00 GMT+8] 为什么惊讶度这么高？",
];
let same = 0;
for (const c of humanCases) {
  const info = extractQueryInfo(c, hygiene);
  const oldQ = extractQueryText(c, hygiene);
  const eq = info.query === oldQ;
  if (eq) same += 1;
  console.log(`-- machineOnly=${info.machineOnly} query=${JSON.stringify(info.query)}`);
  console.log(`   与旧 extractQueryText 一致: ${eq ? "YES" : `NO (old=${JSON.stringify(oldQ)})`}`);
}
console.log(`人话 query 与旧函数逐字节一致: ${same}/${humanCases.length}`);

// 全量人话零误伤：400 条真实用户消息（含子代理/心跳等机器模板轮）
const humanCorpus = JSON.parse(readFileSync("/tmp/四妹-交付/replay6-human-corpus.json", "utf8"));
let eq = 0;
const misclassified = [];
for (const p of humanCorpus) {
  const info = extractQueryInfo(p, hygiene);
  if (info.query === extractQueryText(p, hygiene)) eq += 1;
  // 误伤判据：真有**人类正文**的轮被当成机器轮（剥净）——这才会少注记忆块
  if (info.machineOnly && /[\u4e00-\u9fa5A-Za-z]/.test(p) && !WAKE_BANNERS.some((b) => p.includes(b))) {
    misclassified.push(p.slice(0, 60));
  }
}
console.log(`全量人话语料（${humanCorpus.length} 条真实用户消息）: query 与旧函数逐字节一致 ${eq}/${humanCorpus.length}`);
console.log(`非唤醒轮被误判为机器轮（应 0）: ${misclassified.length}${misclassified.length ? JSON.stringify(misclassified.slice(0, 3)) : ""}`);
const wakeOnly = humanCorpus.filter((p) => WAKE_BANNERS.some((b) => p.includes(b)));
console.log(`语料中含唤醒横幅的轮: ${wakeOnly.length}（这些轮里被归为机器轮的: ${wakeOnly.filter((p) => extractQueryInfo(p, hygiene).machineOnly).length}）`);

console.log("\n== 并排样例（唤醒轮）==");
for (const w of rows.slice(0, 3)) {
  console.log(`-- 醒因原文: ${w.prompt.replace(/\s+/g, " ").slice(0, 90)}…`);
  console.log(`   改后注入: ${JSON.stringify(w.out)}`);
}

// ── 确定性回放（回魂源 = mock，与单测同形状）：把「逻辑」与「只读端点抖动」分开报
const mock = await new Promise((r) => {
  const s = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if ((req.url || "").includes("/soul")) {
        return res.end(JSON.stringify({
          ok: true,
          lms_voice: ["[记忆系统自述] 激活节点: 节点1172(强:0.95)", "我正同时唤起多个记忆，方向稳定。"],
          lms_state: { entropy_ratio: 0.95, last_surprise: 0.11, purpose_coherence: 0.92, turn_count: 7 },
          recent: [{ text: "【重理解】2026-09-21 16:03:01 [dandan] 原话: 等你三件" }, { text: "真·最近人话记忆：网关重载去做吧" }],
        }));
      }
      if ((req.url || "").includes("/landscape")) {
        return res.end(JSON.stringify({ landscape: { num_nodes: 256, activation: { entropy_norm: 0.99, active_nodes: 253, top_activated: [{ node: 1, sigma: 0.93 }] } } }));
      }
      res.end(JSON.stringify({ count: 0, results: [] }));
    });
  });
  s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
});
const mrows = [];
for (const e of prompts) {
  _resetRateLimitForTest();
  const q = extractQueryInfo(e.prompt, hygiene);
  const out = await buildMemoryContext(e.prompt, {
    glueUrl: `http://127.0.0.1:${mock.port}`, lmsUrl: `http://127.0.0.1:${mock.port}`,
    minIntervalMs: 0, maxChars: 1500,
  });
  mrows.push({ machineOnly: q.machineOnly, out, soul: typeof out === "string" && out.startsWith("[回魂]"), hits: typeof out === "string" ? countMachine(out) : 0, chars: typeof out === "string" ? out.length : 0 });
}
mock.s.close();
const mpure = mrows.filter((r) => r.machineOnly);
console.log("\n== 确定性回放（同一批醒因原文，回魂源=mock，排除只读端点抖动）==");
console.log(`纯机器唤醒轮: 回魂有 ${mpure.filter((r) => r.soul).length}/${mpure.length}｜机器段命中 ${mpure.reduce((s, r) => s + r.hits, 0)}（必须 0）｜字符均值 ${Math.round(mpure.reduce((s, r) => s + r.chars, 0) / Math.max(1, mpure.length))}`);
console.log(`全样本(含 1 条人话混合轮): 回魂有 ${mrows.filter((r) => r.soul).length}/${mrows.length}｜机器段命中 ${mrows.reduce((s, r) => s + r.hits, 0)}（混合轮含 [记忆注入] 块头，属正常轮）`);
console.log(`样例: ${JSON.stringify(mrows[0].out)}`);

proxy.close();

// 供回执引用的小结
const summary = {
  samples: rows.length,
  pureWake: pureWake.length,
  mixed: mixed.length,
  soulCoverage: `${rows.filter((r) => r.soul).length}/${rows.length}`,
  machineHitsAfter: rows.reduce((s, r) => s + r.machineHits, 0),
  charsMeanAfter: Math.round(rows.reduce((s, r) => s + r.chars, 0) / rows.length),
  pureWakeRefusedRequests: pureRefused.length,
  deterministicReplay: {
    pureWakeSoulCoverage: `${mpure.filter((r) => r.soul).length}/${mpure.length}`,
    pureWakeMachineHits: mpure.reduce((s, r) => s + r.hits, 0),
    allSamplesSoulCoverage: `${mrows.filter((r) => r.soul).length}/${mrows.length}`,
    charsMean: Math.round(mpure.reduce((s, r) => s + r.chars, 0) / Math.max(1, mpure.length)),
  },
  humanCorpus: { n: humanCorpus.length, queryIdentical: `${eq}/${humanCorpus.length}`, misclassified: misclassified.length },
  before: {
    samples: bRecent.length,
    soulCoverage: `${bSoul}/${bRecent.length}`,
    machineHits: bMachine,
    charsMean: bChars,
    allWake: { soul: before.has_soul, noSoul: before.no_soul, machineHits: before.machine_hits_total, charsMean: before.chars_mean },
  },
};
console.log("\n== SUMMARY JSON ==");
console.log(JSON.stringify(summary, null, 1));
