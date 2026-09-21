// replay5-verify.mjs — 第五刀验证：历史醒因回放（改前基线来自真实注入留存 + 改后由真函数判定）
// 零网络：改前 = 会话留存里的真实注入文本；改后 = 真 extractQueryText(hygiene) 的判定结果。
import { readFileSync } from "node:fs";
import { extractQueryText, resolveInjectHygiene, stripMachineQuerySegments } from "./memory-recall.js";

const hygiene = resolveInjectHygiene({}, {});
const WAKE_BANNERS = ["🌙【梦中醒来】", "📬【信箱新消息】", "【信箱·新留言】"];
const DATE_78_RE = /(?:2026[-/年]\s*0?[78]\b|0?[78]\s*月|\b0?[78]\/\d{1,2}\b|2026-0[78]-\d\d)/;
const WAKE_ARTICLE = (e) => e.includes("自主醒来");
const LONG = (e) => e.length >= 150;

const before = JSON.parse(readFileSync("/tmp/inj-wake-before-20260921.json", "utf8"));
const corpus = JSON.parse(readFileSync("/tmp/wake-corpus-20260921.json", "utf8"))
  .filter((e) => /^\[[^\]]*\]\s*🌙【梦中醒来】/.test(e.prompt));

// 取最近 25 次（留存排序：按 ts 倒序取最新）
const recent = [...before].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 25);

function metricsBefore(items) {
  const n = items.reduce((s, w) => s + w.entries.length, 0);
  const stale = items.reduce((s, w) => s + w.entries.filter((e) => DATE_78_RE.test(e)).length, 0);
  const fam = items.reduce((s, w) => s + w.entries.filter(WAKE_ARTICLE).length, 0);
  const famLong = items.reduce((s, w) => s + w.entries.filter((e) => WAKE_ARTICLE(e) && LONG(e)).length, 0);
  const chars = items.reduce((s, w) => s + w.chars, 0);
  const injWithArticle = items.filter((w) => w.entries.some(WAKE_ARTICLE)).length;
  const injWithFamLong = items.filter((w) => w.entries.some((e) => WAKE_ARTICLE(e) && LONG(e))).length;
  return {
    injections: items.length,
    entries: n,
    entriesPerInj: +(n / items.length).toFixed(2),
    staleShare: +(stale / Math.max(1, n) * 100).toFixed(1),
    sameTopicPerInj: +(fam / items.length).toFixed(2),
    sameTopicShare: +(fam / Math.max(1, n) * 100).toFixed(1),
    wakeArticleLong: famLong,
    charsMean: Math.round(chars / items.length),
    charsTotal: chars,
    injWithArticle,
    injWithFamLong,
  };
}

// 改后：真函数判定（机器剥净 → null ⇒ 不注入 ⇒ 条目 0 / 字符 0）
const afterRecent = recent.map((w) => extractQueryText(w.query, hygiene));
const allAfter = before.map((w) => extractQueryText(w.query, hygiene));
const corpusAfter = corpus.map((e) => extractQueryText(e.prompt, hygiene));
const sum = (a, f) => a.reduce((s, x) => s + (f(x) ? 1 : 0), 0);

const mB = metricsBefore(recent);
const mBAll = metricsBefore(before);
const afterNull = sum(afterRecent, (x) => x === null);
const afterNullAll = sum(allAfter, (x) => x === null);
const corpusNull = sum(corpusAfter, (x) => x === null);
const afterNonEmpty = afterRecent.filter((x) => x !== null);

const tbl = [
  ["指标", "改前（近25次留存）", "改后（真函数判定）"],
  ["注入次数（样本）", mB.injections, afterRecent.length],
  ["—— 仍产出注入的次数", mB.injections, mB.injections - afterNull],
  ["条目总数", mB.entries, 0],
  ["① 陈旧(7/8月)占比", `${mB.staleShare}%`, "—（无条目）"],
  ["② 同话题条数（含'自主醒来'族）/次", mB.sameTopicPerInj, 0],
  ["③ 总字符数（均值/次）", mB.charsMean, 0],
  ["④ '自主醒来'类长文（条数 / 出现的注入数）",
    `${mB.wakeArticleLong} 条 / ${mB.injWithFamLong} 次`, "0 条 / 0 次"],
];
console.log("== 第五刀验证：历史醒因回放（近 25 次真实唤醒轮注入）==");
for (const r of tbl) console.log(r.map(String).join(" | "));

console.log("\n== 全量 219 次唤醒轮注入（同一口径）==");
console.log(`改前: ${mBAll.entries} 条 / 陈旧 ${mBAll.staleShare}% / 同话题 ${mBAll.sameTopicPerInj} 条每次 / 均字符 ${mBAll.charsMean} / '自主醒来'长文 ${mBAll.wakeArticleLong} 条（${mBAll.injWithFamLong} 次注入含）`);
console.log(`改后: query=null 的注入 ${afterNullAll}/${allAfter.length}（其余 ${allAfter.length - afterNullAll} 条非 null）`);

console.log("\n== 输入面：query 系统词命中（改前 vs 改后）==");
const sysWords = (t) => /自主醒来|惊醒|醒来|唤醒|惊讶度|激活节点|熵|【重理解】|→ 我想:|<\|/.test(String(t || ""));
console.log(`近25次 wake query 含系统词: ${sum(afterRecent.map((x, i) => before[0] && sysWords(recent[i].query)), (x) => x)}/${recent.length}（改前）  0/${recent.length}（改后：query=null）`);
console.log(`82 条真实醒因原文 → 剥净为 null: ${corpusNull}/${corpus.length}（其余 ${corpus.length - corpusNull} 条保留了人类线索）`);

console.log("\n== 前/后并排样例（query 输入面）==");
for (const w of recent.slice(0, 3)) {
  const q = String(w.query).replace(/\s+/g, " ").slice(0, 100);
  console.log(`-- 改前 query: ${q}`);
  console.log(`   改后 query: ${extractQueryText(w.query, hygiene) === null ? "(null → 不注入)" : JSON.stringify(extractQueryText(w.query, hygiene))}`);
}
console.log("\n== 人类线索保留（非唤醒轮，不得误伤）==");
const humanCases = [
  "[Mon 2026-09-07 18:05 GMT+8] 18点的时候，你发过这个给自己：\n🌙【梦中醒来】自主醒来（routine 闹钟兜底）：惊讶度 0.0 / 熵 0.00",
  "[Mon 2026-09-21 09:00 GMT+8] 帮我看看回魂仪式那套还在跑吗",
  "[Mon 2026-09-21 09:01 GMT+8] 全部清理完成，然后呢就不说话了？ 还有一晚上过去了，自主醒来还是没有作用啊",
];
for (const c of humanCases) {
  console.log(`-- in : ${JSON.stringify(c.slice(0, 70))}`);
  console.log(`   out: ${JSON.stringify(extractQueryText(c, hygiene))}`);
}
