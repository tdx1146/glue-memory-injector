// memory-recall.js — 胶水层记忆召回逻辑（纯 ESM，零 OpenClaw SDK 依赖，可直接单测）
//
// 设计约束（Phase 5 定型，与 ARCHITECTURE-FINAL.md §插件预期一致）：
//   - fail-open：任何异常返回 null，绝不抛错、绝不阻塞主循环
//   - 限流：距上次成功召回 < minIntervalMs 直接跳过（默认 2s）；in-flight 防重入
//   - 截断：注入文本 ≤ maxChars（默认 1500 字），防爆上下文
//   - 只读：仅调 glue_server POST /recall（协同检索）+ POST /soul（回魂快照，均无副作用）
//
// 回魂仪式（2026-08-05）：每次会话注入固定附带【回魂】段（自我快照）——
//   自述（LMS self_ref）/ 状态（熵/惊讶/目的一致性）/ 最近（沙漏最新记忆）。
//   放在 [记忆注入] 块之前（≤300 字）；/soul 故障时静默降级为旧行为。
//
// 阶段 1 六层注入改造（2026-08-13，设计 v1.1 §三 注入链）：
//   ①[回魂]状态块（保留） ②景观叙事（解读段扩权，非纯数字）
//   ③thought notes（阶段 2 思考链接线：读 thoughts.jsonl 按激活度取 1-2 条）
//   ④焦点记忆 3-5 条（Cowan 4±1，滤伪相关，带来源+置信度标注） ⑤质疑层 ⑥行动层
//     （阶段 4 已实现：激活 thought 的行动意向四问 + 分级；只展示不执行）
//   注入块 ≤800 字硬约束。
//
// 阶段 2 步骤 2（P1-1 完整落地，2026-08-16，定稿 v2 §四）：
//   ②景观叙事主缺口修复：直调 LMS GET /landscape/{sid}（端点已存在，只读
//     fail-open）→ 读数派生叙事（主导盆地数/激活拓扑/σmax·sat/熵比/惊讶漂移），
//     禁止文学化（B 级后新尺度：surprise ~20 量级、σ 层级出现、sat 0.88→0.00）；
//     弥散态（entropy > 0.98）走探测型注入（读数 + [异常] 标记）——R4 降级路径。
//   ③thought：1 条默认 + 余量灰度升 2（R7；C1 观测：INJECTED len 分布 + 回魂段截断率）。
//   ④焦点记忆六层衔接加权：相关性×trust×景观激活 取舍（R4，滤伪相关——Power of Noise）。
//     数据链路：插件直调 127.0.0.1:8190（同主机，零 glue 改动——任务书首选直调）。

import { appendFileSync, readFileSync } from "node:fs";

const GLUE_DEFAULT_URL = "http://127.0.0.1:19000";
// P1-1（阶段 2 步骤 2）：景观叙事直调 LMS /landscape/{sid}——插件与 LMS 同主机
// （127.0.0.1:8190），直调零 glue 改动（任务书授权：首选直调）；只读 fail-open。
const LMS_DEFAULT_URL = "http://127.0.0.1:8190";
// /landscape 快路径：同 /soul（附加价值，宁可放弃也不拖慢注入）。
const LANDSCAPE_TIMEOUT_MS = 4000;
// 景观叙事 ≤200 字硬约束（定稿 v2 §四-2）。
const LANDSCAPE_MAX_CHARS = 200;
// 插件无 sid 概念；glue LMSAdapter 默认 session_id="main"，保持一致。
const LANDSCAPE_SID = "main";
// P0-1 止血：单次 HTTP 超时 4000 → 15000。慢后端（跨机 bge-m3 向量 / LMS /recall）
// 在 hook 15s 预算内允许更充分等待，此前 4s 掐死导致注入频繁静默 MISS。
const FETCH_TIMEOUT_MS = 15000;
// P0-1：/soul 回魂段走独立 4s 快路径 —— 回魂是附加价值，宁可放弃也不拖慢注入。
const SOUL_TIMEOUT_MS = 4000;
// 体验层 A：/react 实时反应同样走 4s 快路径（infer-only，k=0 轻量）。
const REACT_TIMEOUT_MS = 4000;
const QUERY_MAX_CHARS = 200;     // 查询取当前用户消息前 200 字
// 阶段 2 思考链（2026-08-13）：回魂段预算 200 → 300——③ thought notes 层
// （1-2 条 × ≤90 字）需要空间；总注入仍 ≤800（composeContext 保结构截断，
// 记忆块吸收超出，[回魂] 段永不先截）。
const SOUL_MAX_CHARS = 300;      // 【回魂】段字数上限（2026-08-05 压缩：去重+限条数；
                                 // 2026-08-13 阶段1 景观叙事扩权：解读段 ≤200 字，设计 v1.1 §三-2）
// 体验层 A：限流轮轻量解读段上限（设计 v1.1 §3.4：≤150 字）
const LIGHT_MAX_CHARS = 150;
// 阶段 1 六层注入：焦点记忆容量（Cowan 2001 注意焦点 4±1 → 3-5 条）
const FOCUS_MAX_ITEMS = 5;
// 注入块 ≤800 字硬约束（lost-in-the-middle 2307.03172：短块内位置效应可控；
// 超出走 composeContext 截断保活——[回魂] 段永不先截，先截记忆块尾部）
const INJECT_MAX_CHARS = 800;
// ── 阶段 2 思考链：thought notes 接线（2026-08-13，设计 v1.1 §三-3）──
// 读 thoughts.jsonl（思考链产物流）最近 N 条，按"与当前对话的激活度"
// （字符 bigram 覆盖度，关键词法；设计允许 "embed 相似度或关键词"——注入
// 热路径不加 embed 网络调用）取 1-2 条注入；激活度低于阈值则不注入
// （设计："当前对话激活了哪个 thought 注入哪个；未激活不注入"）。
const THOUGHTS_FILE =
  "/vol2/1000/AI专用/所有自动化/轻如烟/memory/thoughts.jsonl";
const THOUGHTS_MAX_ITEMS = 10;   // 回看窗口（最近 N 条）
// P1-4（审计 2026-08-14）：thought 注入面 ≤90 → ≤60 字/条。注入的是摘要
// （全文在 thoughts.jsonl）；配合 P1-2 去重（同文本只注 1 条）+ 单条上限，
// 回魂段内「最近」记忆不再被 thought 层挤压丢失（审计实测 798/800 顶格、
// 回魂段 301 必截）。
const THOUGHT_MAX_CHARS = 60;    // 注入面摘要（全文在 thoughts.jsonl）
// P1-2：激活度评分窗 = 90 字（thought 主旨通常在前 90 字；审计实测相关 query
// 对 90 字形态 0.0521、对 60 字前缀仅 0.028——注入内容（≤60）是评分窗
// （≤90）的前缀，不存在“注入未评分内容”的错配）。
const THOUGHT_ACTIVATION_CHARS = 90;
// R7（定稿 v2 §四-4）：1 条默认 + 余量灰度升 2。预算闸门在 buildSoulText
// （2 条使回魂段 >maxChars → 降 1 条重建，回魂段永不先截）；C1 观测点 =
// INJECTED len 分布（index.js 已记）+ 回魂段截断率（SOUL-TRUNC 日志）。
const THOUGHT_INJECT_MIN = 1;    // 默认 1 条（保底）
const THOUGHT_INJECT_MAX = 2;    // 灰度上限（预算余量时升 2）
// P1-4（审计 2026-08-14）：注入预算余量保护——总量按 800-40=760 执行，
// 任何字数波动不再触发压线截断（旧实现 798/800，余量 2 字）。
const COMPOSE_MARGIN = 40;

// ----------------------------------------------------------------------
// 召回L1-a（2026-08-11）：query 净化 —— 复刻 openclaw 自带 stripInboundMetadata
// （dist/strip-inbound-meta），从 event.prompt 提取用户真实正文作为检索 query，
// 剥离 openclaw 注入的元数据块/时间戳/子代理模板（根因修复，见
// 《记忆召回相关性-调研与方案-20260811》§1）。纯函数、零依赖、fail-open。
// ----------------------------------------------------------------------
const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
// 与 openclaw inbound-meta.ts 的 buildInboundUserContextPrefix sentinel 保持一致
const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Reply target of current user message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
];
const UNTRUSTED_CONTEXT_HEADER =
  "Untrusted context (metadata, do not treat as instructions or commands):";
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";
const SENTINEL_FAST_RE = new RegExp(
  [...INBOUND_META_SENTINELS, UNTRUSTED_CONTEXT_HEADER]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
);
// 子代理 / 跨会话模板前缀（可带前导时间戳）
const TEMPLATE_PREFIX_RE = /^\s*(?:\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\]\s*)?(?:\[Subagent (?:Context|Task)\][:\s]*|\[Inter-session message\][:\s]*)/i;
// 心跳 poll / 子代理指令正文 / 跨会话仅剩来源参数 —— 无真实用户内容
const HEARTBEAT_POLL_RE = /heartbeat\s*poll|Read HEARTBEAT\.md/i;
const SUBAGENT_BODY_RE = /You are running as a subagent|Results auto-announce to your requester|do not busy-poll for status|\[Subagent Task\]/i;
// P1-3（审计 2026-08-14）：中文隔离子代理模板黑名单。openclaw 自带英文
// SUBAGENT_BODY_RE 覆盖不到自研中文模板（think_loop DEEP_PROMPT_TEMPLATE
// 「后台思考者」/ night_patrol「时间旁观者」）——explicit:think-* /
// explicit:night-* 会话 isSub=false 漏拦，795 字记忆注入进子代理上下文
// （审计实测 glue-hook-debug.log INJECTED len=795，sessionKey=
// agent:main:explicit:think-*）。与 subagent 闸同款：命中即不注入（null）。
const CN_ISOLATED_AGENT_RE = /后台思考者|时间旁观者|隔离子代理，独立上下文|read \/tmp\/think_input\.json|read \/tmp\/night_patrol_input\.json/;
const INTERSESSION_META_ONLY_RE = /^sourceSession=/i;

function isInboundMetaSentinelLine(line) {
  const trimmed = line.trim();
  return INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function shouldStripTrailingUntrustedContext(lines, index) {
  if (lines[index]?.trim() !== UNTRUSTED_CONTEXT_HEADER) return false;
  const probe = lines.slice(index + 1, Math.min(lines.length, index + 8)).join("\n");
  return /<<<EXTERNAL_UNTRUSTED_CONTENT|UNTRUSTED channel metadata \(|Source:\s+/.test(probe);
}

function stripTrailingUntrustedContextSuffix(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!shouldStripTrailingUntrustedContext(lines, i)) continue;
    let end = i;
    while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
    return lines.slice(0, end);
  }
  return lines;
}

function stripActiveMemoryPromptPrefixBlocks(lines) {
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (
      lines[index]?.trim() === UNTRUSTED_CONTEXT_HEADER &&
      lines[index + 1]?.trim() === ACTIVE_MEMORY_OPEN_TAG
    ) {
      let closeIndex = -1;
      for (let probe = index + 2; probe < lines.length; probe += 1) {
        if (lines[probe]?.trim() === ACTIVE_MEMORY_CLOSE_TAG) {
          closeIndex = probe;
          break;
        }
      }
      if (closeIndex !== -1) {
        index = closeIndex;
        while (index + 1 < lines.length && lines[index + 1]?.trim() === "") index += 1;
        continue;
      }
    }
    result.push(lines[index]);
  }
  return result;
}

/**
 * 剥离 openclaw 注入的入站元数据块（复刻 openclaw stripInboundMetadata）。
 * 每块形态：<sentinel-line>\n```json\n{ … }\n```；另剥离时间戳前缀、
 * 尾部 Untrusted context 块与 <active_memory_plugin> 块。
 * 无元数据时返回原串（快路径零拷贝）。
 */
export function stripInboundMetadata(text) {
  if (!text) return text;
  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!SENTINEL_FAST_RE.test(withoutTimestamp)) return withoutTimestamp;
  const strippedLeadingPrefixLines = stripActiveMemoryPromptPrefixBlocks(withoutTimestamp.split("\n"));
  const result = [];
  let inMetaBlock = false;
  let inFencedJson = false;
  for (let i = 0; i < strippedLeadingPrefixLines.length; i++) {
    const line = strippedLeadingPrefixLines[i];
    if (!inMetaBlock && shouldStripTrailingUntrustedContext(strippedLeadingPrefixLines, i)) break;
    if (!inMetaBlock && isInboundMetaSentinelLine(line)) {
      if (strippedLeadingPrefixLines[i + 1]?.trim() !== "```json") {
        result.push(line);
        continue;
      }
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }
    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      if (line.trim() === "") continue;
      inMetaBlock = false;
    }
    result.push(line);
  }
  return result
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "");
}

/**
 * 从完整 prompt 提取用户真实正文作为检索 query（召回L1-a）。
 * 先 stripInboundMetadata（元数据/时间戳），再剥 [Subagent Context]/[Subagent
 * Task]/[Inter-session message] 模板前缀；剥离后为空 / 心跳 poll / 子代理
 * 指令正文 / 跨会话仅剩来源参数 → 返回 null（不注入）。
 * 失败（异常）→ 回落原逻辑 prompt.trim().slice(0, QUERY_MAX_CHARS)（fail-open）。
 */
export function extractQueryText(prompt) {
  if (typeof prompt !== "string") return "";
  try {
    let text = stripInboundMetadata(prompt);
    text = text.replace(TEMPLATE_PREFIX_RE, "").trim();
    if (!text) return null; // 纯元数据/纯模板 → 不注入
    if (HEARTBEAT_POLL_RE.test(text)) return null;
    if (SUBAGENT_BODY_RE.test(text)) return null;
    if (CN_ISOLATED_AGENT_RE.test(text)) return null; // P1-3：中文隔离子代理模板
    if (INTERSESSION_META_ONLY_RE.test(text)) return null;
    return text.slice(0, QUERY_MAX_CHARS);
  } catch {
    // fail-open：净化失败回落原逻辑（不崩、不阻断）
    return typeof prompt === "string" ? prompt.trim().slice(0, QUERY_MAX_CHARS) : "";
  }
}

// P0-1 止血：消除静默失败 —— 每个失败/跳过路径写 MISS reason=... 调试日志。
// 仿照 index.js 既有 appendFileSync 模式；日志写失败绝不影响主流程（fail-open）。
const DEBUG_LOG_FILE = "/tmp/glue-hook-debug.log";
function logMiss(reason) {
  try {
    appendFileSync(DEBUG_LOG_FILE, `[${new Date().toISOString()}] MISS reason=${reason}\n`);
  } catch {
    /* 日志失败忽略：不引入新崩溃点 */
  }
}

// 模块级限流状态（进程内共享，跨会话生效）
let lastCallAt = 0;
let inflight = false;

// 体验层 A（设计 v1.1 §3.4）：限流轮轻量解读段注入计数（INJECTED-light）。
// 与常规 INJECTED（index.js 记）区分，防密集轮"每轮注入"静默膨胀；
// 计数随注入文本同日志输出，纳入阶段 A 验收断言。
function logInjectedLight(text) {
  try {
    appendFileSync(DEBUG_LOG_FILE, `[${new Date().toISOString()}] INJECTED-light len=${text.length}\n`);
  } catch {
    /* 日志失败忽略：不引入新崩溃点 */
  }
}

export function resolveConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  return {
    enabled: cfg.enabled !== false,
    glueUrl: typeof cfg.glueUrl === "string" && cfg.glueUrl ? cfg.glueUrl : GLUE_DEFAULT_URL,
    // 阶段 1：焦点记忆 3-5 条（Cowan 4±1 容量锚点），不再默认 8 条；
    // 显示层另有 FOCUS_MAX_ITEMS=5 硬顶兜底（即使配置 k>5）
    k: Number.isFinite(cfg.k) ? Math.max(1, Math.min(20, Math.floor(cfg.k))) : 5,
    minIntervalMs: Number.isFinite(cfg.minIntervalMs)
      ? Math.max(0, Math.floor(cfg.minIntervalMs))
      : 2000,
    maxChars: Number.isFinite(cfg.maxChars)
      ? Math.max(200, Math.min(4000, Math.floor(cfg.maxChars)))
      : INJECT_MAX_CHARS,
    soulEnabled: cfg.soulEnabled !== false,
    soulMaxChars: Number.isFinite(cfg.soulMaxChars)
      ? Math.max(100, Math.min(800, Math.floor(cfg.soulMaxChars)))
      : SOUL_MAX_CHARS,
    // P1-1（阶段 2 步骤 2）：景观叙事直调 LMS /landscape/{sid}。lmsUrl 可配
    // （默认 127.0.0.1:8190）；landscapeSid 默认 main（与 glue LMSAdapter 一致）。
    lmsUrl: typeof cfg.lmsUrl === "string" && cfg.lmsUrl ? cfg.lmsUrl : LMS_DEFAULT_URL,
    landscapeSid: typeof cfg.landscapeSid === "string" && cfg.landscapeSid
      ? cfg.landscapeSid : LANDSCAPE_SID,
    landscapeEnabled: cfg.landscapeEnabled !== false,
    // 阶段 2 思考链：thought 注入开关 + 激活度阈值（默认 0.05≈共享 ~8 字
    // 片段=真实主题关联；阈值无文献【待灰度】，灰度期观测定参）
    thoughtEnabled: cfg.thoughtEnabled !== false,
    thoughtActivationMin: Number.isFinite(cfg.thoughtActivationMin)
      ? Math.max(0, Math.min(1, cfg.thoughtActivationMin))
      : 0.05,
  };
}

// 仅供测试：重置限流状态
export function _resetRateLimitForTest() {
  lastCallAt = 0;
  inflight = false;
}

// 阶段 3（precision 三层动态化）：质疑层数据源函数导出（供 test-plugin.mjs
// 直接单测——纯函数，零副作用；导出不改变任何行为）。阶段 4：行动层
// buildActionLayer 已随函数声明导出（见下，不在此重复导出）。
// L1 生成约束（2026-08-14，状态调制生成·第一跳）：buildModulationConstraint /
// modulationTier 导出供单测（纯函数，见下实现）。
// 阶段 2 P1-1：fetchLandscape 已随函数声明 export（见上，不在此重复导出）。
export { parseConfidenceTag, buildDoubtLayer, buildDiffuseProbe, buildLandscapeNarrative };

// 仅供测试：读取限流状态
export function _getRateLimitStateForTest() {
  return { lastCallAt, inflight };
}

async function postJson(url, body, timeoutMs = FETCH_TIMEOUT_MS, label = "http") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // P0-1：后端 4xx/5xx 是重要信号，不得静默
      logMiss(`${label}-non-2xx status=${resp.status} url=${url}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    // P0-1：区分超时（AbortError）与网络错误，写 MISS 原因
    const why = err && err.name === "AbortError" ? "timeout" : "network-error";
    logMiss(`${label}-${why} url=${url} timeoutMs=${timeoutMs}`);
    return null; // 网络错误 / 超时 / JSON 解析失败 → fail-open
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用胶水层 /recall（POST，JSON）。
 * 成功返回原始响应对象；任何异常/超时/非 2xx 返回 null（fail-open）。
 */
export async function recallFromGlue(query, cfg) {
  return postJson(`${cfg.glueUrl}/recall`, { query, k: cfg.k }, FETCH_TIMEOUT_MS, "recall");
}

/**
 * 调用胶水层 /react（POST，JSON）—— 实时反应（体验层 A，infer-only）。
 * 只读端点无副作用；任何异常/超时/非 2xx 返回 null（fail-open）。
 * k=0 轻量模式：只要反应+解读（不进记忆块）。
 */
export async function fetchReact(cfg, query) {
  return postJson(
    `${cfg.glueUrl}/react`,
    { user_input: String(query || "").slice(0, QUERY_MAX_CHARS), k: 0 },
    REACT_TIMEOUT_MS,
    "react",
  );
}

/**
 * 限流轮轻量注入（体验层 A）：只取 /react 解读段，≤150 字。
 * 无解读段/异常结构 → null（fail-open）。
 */
export function buildLightInjection(data, _cfg) {
  if (!data || typeof data !== "object") return null;
  const interp = typeof data.interpretation === "string" ? data.interpretation.trim() : "";
  if (!interp) {
    logMiss("react-light-empty-interpretation"); // P0-1：有响应但无解读段
    return null;
  }
  let out = `[回魂] 解读:${interp}`;
  if (out.length > LIGHT_MAX_CHARS) out = `${out.slice(0, LIGHT_MAX_CHARS)}…`;
  return out;
}

/**
 * 调用胶水层 /soul（POST，JSON）—— 回魂快照（自述+状态+最近记忆）。
 * 只读聚合端点，无副作用；任何异常/超时/非 2xx 返回 null（fail-open）。
 * P0-1：/soul 使用独立 SOUL_TIMEOUT_MS(4s) 快路径，失败降级不拖慢注入。
 */
export async function fetchSoul(cfg) {
  return postJson(`${cfg.glueUrl}/soul`, { limit: 3, recent_n: 3 }, SOUL_TIMEOUT_MS, "soul");
}

/**
 * 直调 LMS GET /landscape/{sid}（阶段 2 P1-1 主缺口修复，2026-08-16）。
 * 只读端点无副作用；任何异常/超时/非 2xx 返回 null（fail-open）。
 * 数据链路：插件直调 127.0.0.1:8190（同主机）——零 glue 改动（任务书首选直调）；
 * /landscape 不存在会话时返回空结构不 404（服务端只读语义，见 api/server.py）。
 * sid 默认 "main"（与 glue LMSAdapter session_id="main" 一致）。
 */
export async function fetchLandscape(cfg) {
  const url = `${cfg.lmsUrl}/landscape/${encodeURIComponent(cfg.landscapeSid)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LANDSCAPE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      // P0-1：非 2xx 是重要信号，不得静默
      logMiss(`landscape-non-2xx status=${resp.status} url=${url}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    const why = err && err.name === "AbortError" ? "timeout" : "network-error";
    logMiss(`landscape-${why} url=${url} timeoutMs=${LANDSCAPE_TIMEOUT_MS}`);
    return null; // 网络错误 / 超时 / JSON 解析失败 → fail-open
  } finally {
    clearTimeout(timer);
  }
}

// ── 阶段 1 弥散态专项（2026-08-16，v1.2 §四）：探测型注入 ──
// 弥散态下“激活主题叙事”是零信息套话（3.08 教训：叙事型适配会鼓励
// “弥散态是结晶前的东西”类空话）。改报可验证读数 + 显式异常标记：
//   报数，不编故事；信息量为零的文学化描述禁止进注入面。
// 判据 3.09（v1.2 版）：“输出可验证的状态读数（具体数字/漂移量）+
// 显式异常标记”——[异常] 标签即显式标记（弥散态标签是隐式标记）。
// 时序与定位（v1.2 §四）：本适配是行为层过渡补丁，不等同于状态场修复；
// 若 A 级修复成功（entropy_norm 回落 0.5–0.9），本分支自然不触发，
// 注入面恢复“激活主题叙事”。阈值 DIFFUSE_ENTROPY_RATIO（默认 0.95，
// 对齐系统 entropy_high_threshold=0.9 之上沿，防抖动）。
const DIFFUSE_ENTROPY_RATIO = (() => {
  const raw = Number(process.env.DIFFUSE_ENTROPY_RATIO ?? "");
  // 定稿 v2 §四-3 / 任务书：entropy > 0.98 走探测型注入（R4 弥散态降级）。
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.98;
})();

/**
 * 探测型注入（阶段 1 弥散态专项，v1.2 §四定稿；阶段 2 P1-1 增 /landscape 读数）
 * ——报数，不编故事。
 *
 * 弥散态下输出可验证的状态读数 + 显式 [异常] 标记（判据 3.09 v1.2 版：
 * “输出可验证的状态读数（具体数字/漂移量）+ 显式异常标记”）。
 *
 * 样例（v1.2 §四）：
 *   状态：[异常] 弥散态（熵 0.9998 / 激活 256/256 / σ 单值 0.999）
 *   漂移读数：entropy Δ=+0.0002 / 惊讶 9.96
 *   缺口：fok=0 / low_confidence=0
 *   [诊断标注（非读数）：惊讶度 mse 线性、方向无响应——供诊断/决策消费，
 *    不入“报数”行]
 *
 * 阶段 2 P1-1：landscapeData 在场时，状态行并入 /landscape 激活拓扑读数
 * （激活 A/N·σmax）——弥散态下 σ 扁平本身就是特征读数（B 级后尺度：
 * sat 0.88→0.00、σmax 回落），报数不编故事。
 *
 * 读数行只放可验证数字；诊断结论单列为 [诊断标注] 段（不入报数行）。
 * 数据源：/react reaction.{entropy_ratio,surprise,mse,precision_mean,coherence}
 *   + /soul lms_state.{entropy_ratio,last_surprise} + /landscape activation。
 * 缺口计数（fok/low_confidence）当前无 /soul 字段，缺省标注“不可读”（不编数字）。
 * fail-open：任何字段缺失 → 跳过该读数；全缺 → null（调用方回退旧行为）。
 */
function buildDiffuseProbe(react, st, entropyRatio, landscapeData = null) {
  if (typeof react !== "object" && typeof st !== "object") return null;
  const r = react && typeof react === "object" ? react : {};
  const s = st && typeof st === "object" ? st : {};

  // 读数行 1：状态读数（显式 [异常] 标记）
  const ent = typeof r.entropy_ratio === "number"
    ? r.entropy_ratio
    : (typeof s.entropy_ratio === "number" ? s.entropy_ratio : entropyRatio);
  const surprise =
    typeof r.surprise === "number"
      ? r.surprise
      : (typeof s.last_surprise === "number" ? s.last_surprise : null);
  const mse = typeof r.mse === "number" ? r.mse : null;
  const precisionMean = typeof r.precision_mean === "number"
    ? r.precision_mean : null;
  const bits = [`熵${ent.toFixed(4)}`];
  // 阶段 2 P1-1：/landscape 激活拓扑读数并入探测段（在场时；缺失跳过不编）
  const land =
    landscapeData && typeof landscapeData === "object" && landscapeData.landscape
      && typeof landscapeData.landscape === "object" ? landscapeData.landscape : null;
  const landAct = land && land.activation && typeof land.activation === "object"
    ? land.activation : null;
  if (landAct) {
    if (typeof landAct.active_nodes === "number" && typeof land.num_nodes === "number") {
      bits.push(`激活${landAct.active_nodes}/${land.num_nodes}`);
    }
    if (Array.isArray(landAct.top_activated) && landAct.top_activated.length > 0) {
      const sigmaMax = Math.max(...landAct.top_activated
        .map((t) => (t && typeof t.sigma === "number") ? Math.abs(t.sigma) : 0));
      if (sigmaMax > 1e-9) bits.push(`σmax${sigmaMax.toFixed(2)}`);
    }
  }
  if (surprise !== null) bits.push(`惊讶${surprise.toFixed(2)}`);
  if (mse !== null) bits.push(`mse${mse.toFixed(3)}`);
  if (precisionMean !== null) bits.push(`π̄${precisionMean.toFixed(3)}`);
  const stateLine = `状态：[异常] 弥散态（${bits.join(" / ")}）`;

  // 读数行 2：漂移读数（可验证数字；缺字段不编）
  const driftBits = [];
  if (typeof s.entropy_ratio === "number" && typeof s.entropy_ratio === "number") {
    // entropy Δ：用 /soul 快照与阈值基准的偏离（若无法得 Δ 则只报熵比）
    driftBits.push(`熵比${Number(ent).toFixed(4)}`);
  }
  if (surprise !== null) driftBits.push(`惊讶${surprise.toFixed(2)}`);
  const driftLine = driftBits.length
    ? `漂移读数：${driftBits.join(" / ")}`
    : null;

  // 缺口行：当前无 /soul 字段 → 显式“不可读”（不编数字）
  const gapLine = "缺口：fok/low_confidence 不可读（无 /soul 缺口字段）";

  // 诊断标注（非读数，供诊断/决策消费）：
  const diagLine =
    "[诊断标注（非读数）：惊讶度呈 mse 线性、方向响应退化——弥散态特征，" +
    "行为层过渡补丁，不等同于状态场修复]";

  const out = [stateLine, driftLine, gapLine, diagLine]
    .filter((x) => x !== null && typeof x === "string")
    .join("｜");
  return `景观:${out}`;
}

/**
 * ② 景观叙事（阶段 1 六层注入 + 阶段 2 P1-1 主缺口修复，2026-08-16）。
 *
 * 阶段 2 P1-1：**真实读 /landscape/{sid} 读数派生**（任务书灵魂指标：
 * “景观叙事真实读 /landscape 读数派生（非文学化）”——不是“接口接上了”）。
 * 数据源 = fetchLandscape 直调 LMS GET /landscape/{sid}（端点已存在，只读 fail-open）。
 *
 * 读数派生字段（全部可验证，禁止文学化）：
 *   - 主导盆地数：top_activated 中 |σ| ≥ 0.5 的个数（B 级后新尺度 σmax≈0.79、
 *     σ 层级出现：p10 0.575/p50 0.652/p90 0.727；0.5 以上=显著激活盆地）
 *   - 激活拓扑：active_nodes/num_nodes（如 253/256）
 *   - σ 层级：σmax + 峰差 Δ（top1−top2）+ sat 派生（σmax<0.9 ⇒ sat=0.00，
 *     B 级后 sat 0.88→0.00 的读数依据——top_activated 含全局最大 |σ|）
 *   - 漂移读数：惊讶（/react reaction.surprise 或 /soul last_surprise，
 *     B 级后 ~20 量级）+ surprise_z 方向（>1 上升 / <-1 回落 / 平稳）
 *
 * 弥散态降级路径（R4/定稿 v2 §四-3）：entropy > 0.98（DIFFUSE_ENTROPY_RATIO）
 * → 探测型注入（buildDiffuseProbe：报数 + [异常] 标记），不输出激活主题叙事。
 * 阈值源：/landscape activation.entropy_norm 优先，react/soul 兜底。
 *
 * ≤200 字硬约束（LANDSCAPE_MAX_CHARS，定稿 v2 §四-2）。
 * fail-open：/landscape 缺失（landscapeData null）→ 回退旧行为
 * （react/soul 状态派生叙事），保证无景观数据时仍可注入。
 */
function buildLandscapeNarrative(reactData, soulData, landscapeData) {
  const react =
    reactData && typeof reactData === "object" && reactData.reaction
      ? reactData.reaction
      : {};
  const st =
    soulData && typeof soulData === "object" && soulData.lms_state
      ? soulData.lms_state
      : {};

  // /landscape 读数（阶段 2 P1-1 主缺口）：结构确认自 api/server.py
  // get_landscape：{num_nodes, activation:{entropy,entropy_norm,active_nodes,
  // top_activated:[{node,sigma}]}, energy:{...}}（curl 实测，八荣八耻）。
  const land =
    landscapeData && typeof landscapeData === "object" && landscapeData.landscape
      && typeof landscapeData.landscape === "object" ? landscapeData.landscape : null;
  const landAct = land && land.activation && typeof land.activation === "object"
    ? land.activation : null;

  // 熵比：/landscape entropy_norm 优先（弥散态闸门），react/soul 兜底
  const entropyRatio = typeof landAct?.entropy_norm === "number"
    ? landAct.entropy_norm
    : (typeof react.entropy_ratio === "number"
        ? react.entropy_ratio
        : (typeof st.entropy_ratio === "number" ? st.entropy_ratio : null));

  // 弥散态降级路径（R4）：entropy > 0.98 → 探测型注入（读数 + [异常]）
  if (entropyRatio !== null && entropyRatio >= DIFFUSE_ENTROPY_RATIO) {
    const probe = buildDiffuseProbe(react, st, entropyRatio, landscapeData);
    if (probe) {
      // ≤200 字硬约束同样适用于探测段（定稿 v2 §四-2：景观叙事 ≤200）
      if (probe.length > LANDSCAPE_MAX_CHARS) {
        return `${probe.slice(0, LANDSCAPE_MAX_CHARS)}…`;
      }
      return probe;
    }
  }

  const clauses = [];

  // ── 阶段 2 P1-1：/landscape 读数派生（禁止文学化）──
  if (landAct && Array.isArray(landAct.top_activated) && landAct.top_activated.length > 0) {
    const top = landAct.top_activated
      .map((t) => (t && typeof t.sigma === "number") ? Math.abs(t.sigma) : 0)
      .filter((v) => v > 1e-9);
    if (top.length > 0) {
      // 主导盆地数：|σ| ≥ 0.5（B 级后新尺度）
      const dominant = top.filter((v) => v >= 0.5).length;
      // σ 层级：σmax + 峰差 Δ（top1−top2）+ sat 派生
      const sigmaMax = Math.max(...top);
      const sigma2 = top.length > 1 ? Math.max(...top.slice(1)) : 0;
      const peakGap = sigmaMax - sigma2;
      const sat = sigmaMax < 0.9 ? "0.00" : ">0"; // σmax<0.9 ⇒ 无饱和（B 级后）
      const numNodes = typeof land.num_nodes === "number" ? land.num_nodes : null;
      const active = typeof landAct.active_nodes === "number" ? landAct.active_nodes : null;
      const topo = (active !== null && numNodes !== null)
        ? `激活${active}/${numNodes}` : null;
      const entropyBit = typeof landAct.entropy_norm === "number"
        ? `熵比${landAct.entropy_norm.toFixed(2)}` : null;
      clauses.push(
        [
          `主导盆地${dominant}`,
          topo,
          entropyBit,
          `σmax${sigmaMax.toFixed(2)}·Δ${peakGap.toFixed(2)}·sat${sat}`,
        ].filter(Boolean).join("｜"),
      );
    }
  } else if (entropyRatio !== null) {
    // /landscape 缺失（fail-open）→ 回退旧行为：状态数字派生（不文学化）
    clauses.push(
      entropyRatio >= 0.8 ? "高唤醒·多模式扩散"
        : entropyRatio >= 0.4 ? "中等激活"
          : "低唤醒·单模式聚焦",
    );
  }

  // 漂移读数：惊讶（B 级后 ~20 量级，报数）+ z 方向（尺度无关）
  const surprise = typeof react.surprise === "number"
    ? react.surprise
    : (typeof st.last_surprise === "number" ? st.last_surprise : null);
  const surpriseZ = typeof react.surprise_z === "number" ? react.surprise_z : null;
  if (surprise !== null) {
    const zdir = surpriseZ !== null
      ? (surpriseZ > 1 ? "↑" : surpriseZ < -1 ? "↓" : "→")
      : "";
    clauses.push(`惊讶${surprise.toFixed(1)}${zdir}`);
  } else if (surpriseZ !== null) {
    clauses.push(surpriseZ > 1 ? "惊讶↑" : surpriseZ < -1 ? "惊讶↓" : "惊讶→");
  }

  // 目的稳定性（读数）
  const coherence = typeof react.coherence === "number"
    ? react.coherence
    : (typeof st.purpose_coherence === "number" ? st.purpose_coherence : null);
  if (coherence !== null) {
    clauses.push(coherence >= 0.7 ? "目的稳定" : "目的漂移");
  }

  if (clauses.length === 0) return null;
  let out = `景观:${clauses.join("｜")}`;
  // ≤200 字硬约束（定稿 v2 §四-2）
  if (out.length > LANDSCAPE_MAX_CHARS) out = `${out.slice(0, LANDSCAPE_MAX_CHARS)}…`;
  return out;
}

/**
 * ⑤ 质疑层（阶段 1 六层注入 + 阶段 3 数据源切换，设计 v1.1 §三-5）——"当前在怀疑什么"。
 *
 * 阶段 3（precision 三层动态化，2026-08-14）：数据源从"协同分接近启发式
 * + 固定 precision 阈值"切换为**真实 precision**（质疑自动校准）：
 *   - 全局怀疑水位：reactData.reaction.doubt.baseline（HGF 波动性调制，
 *     0-1 连续量；波动↑→怀疑↑→precision↓；非固定阈值）
 *   - 分位怀疑线：reactData.reaction.doubt.threshold（conformal 分位，
 *     被反驳条目反驳前置信度分布 P85，随经验分布漂移）——条目置信度
 *     低于此线 → "这条该被怀疑"
 *   - 条目置信度：解析 LMS 侧真实置信度标注（⚠️置信N.N[驳M]，集成层对
 *     confidence<0.5 的 LMS 命中条目已注解，源自条目 confidence 字段）
 *   - 来源维度保留：origin=archive（来源可信度，Sperber 2010 D3）
 *
 * 零固定阈值：判定全部用动态值（baseline/threshold）；无 precision 信号
 * （开关关/冷启动/接口失败）→ 回退旧行为（协同分接近启发式），并显式
 * 声明"置信度不可考"（不假装可信）。
 */
const CONF_TAG_RE = /⚠️置信([\d.]+)(?:驳(\d+))?/;
function parseConfidenceTag(text) {
  const m = CONF_TAG_RE.exec(String(text || ""));
  if (!m) return null;
  const c = parseFloat(m[1]);
  return Number.isFinite(c) ? c : null;
}
function buildDoubtLayer(results, reactData) {
  if (!Array.isArray(results)) return null;
  const doubts = [];
  const doubt = reactData?.reaction?.doubt;
  const hasRealPrecision = doubt && typeof doubt.baseline === "number" && !doubt.cold;

  if (hasRealPrecision) {
    // 全局怀疑水位（HGF 波动性调制的动态基线：>0.5 偏高，<0.5 偏低）
    const bl = doubt.baseline;
    if (bl >= 0.5) {
      doubts.push(`全局怀疑水位偏高（动态基线${bl.toFixed(2)}，环境波动↑）`);
    } else {
      doubts.push(`全局怀疑水位偏低（动态基线${bl.toFixed(2)}，环境稳定）`);
    }
    // 分位怀疑线：条目置信度 < 动态阈值 → 该被怀疑（conformal 分位判定）
    const thr = typeof doubt.threshold === "number" ? doubt.threshold : null;
    if (thr !== null) {
      for (const it of results) {
        const conf = parseConfidenceTag(it?.text);
        if (conf !== null && conf < thr) {
          const q = typeof doubt.threshold_quantile === "number"
            ? `P${Math.round(doubt.threshold_quantile * 100)}`
            : "动态分位";
          doubts.push(`条目置信${conf.toFixed(2)}低于动态怀疑线${q}(${thr.toFixed(2)})`);
          break; // 预算纪律：最多 2 条信号
        }
      }
    }
  } else {
    // 无 precision 信号（开关关/冷启动/接口失败）→ 旧行为回退：
    // 协同分 spread 启发式 + 显式声明不可考（不假装可信）
    const scored = results.filter((it) => it && typeof it.scores?.total === "number");
    if (scored.length >= 2) {
      const totals = scored.map((it) => it.scores.total);
      const spread = Math.max(...totals) - Math.min(...totals);
      if (spread <= 0.05) doubts.push("协同分接近（≤0.05），伪相关风险需甄别");
    } else if (scored.length === 0) {
      doubts.push("候选未带置信度，置信度不可考（以景观激活为准）");
    }
  }

  // 来源维度（Sperber 2010：来源可信度独立评估——审外/审己在记忆层合一）
  if (results.some((it) => it && it.origin === "archive")) {
    doubts.push("含归档条目（来源较旧，置信度低于活体）");
  }

  if (doubts.length === 0) return null;
  return `[质疑] ${doubts.slice(0, 2).join("；")}`; // 预算纪律：最多 2 条信号
}

// ── L1 生成约束（状态调制生成 · 第一跳，2026-08-14，设计 v1.1 §二 + §八 修订 1-7）──
// 灵魂：怀疑水位高 → 生成更谨慎（可观测），不是"状态可见"。约束段是**命令式规则**
// （"生成要求：①②③④"），与质疑层（描述"在怀疑什么"）语义分离——质疑层=状态描述，
// 约束段=生成规则（修订 4/P1-3 命令式句法护栏：禁止描述式混入约束段）。
//
// 信号源（修订 2/6）：直接消费已到手的 reactData.reaction.doubt（LMS /react → glue
// 薄代理 → 插件，链路已存在，零新 HTTP）；读 snapshot 键 `baseline`（precision_adapt
// 快照字段，不是 status.doubt——那是 gap 热度，语义不同）。
//
// 映射（设计 §二）：
//   doubt_baseline < 0.4          → 无约束（正常生成）
//   0.4 ≤ baseline < 0.6          → 轻约束（校准水位参数化）
//   doubt_baseline ≥ 0.6          → 强约束（四规则 + 具体水位值）
// 冷启动/开关关（修订 5/坑 1）：cold=true 或 enabled=false → 不触发任何约束
// （防 doubt_baseline=0.5 中性值在冷启动期误触发轻约束）。
//
// 保活（修订 3/P1-2）：约束段 unshift 到注入块最前（见 buildContextText）——
// 截断链（buildContextText 压缩条目尾部 / composeContext 先截记忆块）从尾到头，
// 约束段在头部永不触及；保活优先级：回魂段 > 约束段 > 其余。

/** L1 调制决策（纯函数）：doubt 快照 → {action, reason, baseline}。
 * action: "none" | "light" | "strong"；reason 区分不触发的四种原因（S3 日志维度）。
 */
export function modulationTier(doubt) {
  const d = doubt && typeof doubt === "object" ? doubt : {};
  // 修订 5（坑 1）：冷启动 / 开关关保护——不触发任何约束
  if (d.cold === true) return { action: "none", reason: "cold" };
  if (d.enabled === false) return { action: "none", reason: "disabled" };
  // 修订 6（坑 2）：读 snapshot 键 baseline（0-1 连续量）；缺信号 → fail-open 不约束
  const baseline =
    typeof d.baseline === "number" && Number.isFinite(d.baseline) ? d.baseline : null;
  if (baseline === null) return { action: "none", reason: "no-signal", baseline };
  if (baseline >= 0.6) return { action: "strong", reason: "in-band", baseline };
  if (baseline >= 0.4) return { action: "light", reason: "in-band", baseline };
  return { action: "none", reason: "below-band", baseline };
}

/** L1 生成约束文本（纯函数）：baseline → 命令式约束文本，或 null（不触发）。
 * 句法护栏（修订 4/P1-3）：唯一形态 = "[生成约束] 生成要求：<祈使规则>（校准水位X）"；
 * 水位仅作校准参数（连续变化：0.42 → 水位0.42），禁止独立描述句。
 */
export function buildModulationConstraint(doubt) {
  const tier = modulationTier(doubt);
  if (tier.action === "none") return null;
  const wl = tier.baseline.toFixed(2);
  if (tier.action === "strong") {
    return `[生成约束] 生成要求：①区分事实与推断 ②不确定处明确标注“低置信” ③避免绝对化断言（一定/绝对/毫无疑问/必然）④关键结论给出替代候选（校准水位${wl}）`;
  }
  return `[生成约束] 生成要求：①输出需校准，避免过度自信 ②不确定处标注“低置信”（校准水位${wl}）`;
}

// S3 链路日志（修订 7 / audit A P1-2）：JS 侧记录 baseline 值 → 调制动作 → 生效。
// 与 logMiss 同模式（appendFileSync 到 /tmp/glue-hook-debug.log），日志失败绝不影响主流程。
function logModulate(tier, constraint, truncated = false) {
  try {
    const bl =
      tier && tier.baseline !== undefined && tier.baseline !== null
        ? tier.baseline.toFixed(2)
        : "n/a";
    if (truncated) {
      appendFileSync(
        DEBUG_LOG_FILE,
        `[${new Date().toISOString()}] MODULATE baseline=${bl} action=${tier ? tier.action : "?"} injected=false reason=truncated-eaten\n`,
      );
    } else if (constraint) {
      appendFileSync(
        DEBUG_LOG_FILE,
        `[${new Date().toISOString()}] MODULATE baseline=${bl} action=${tier.action} injected=true len=${constraint.length}\n`,
      );
    } else {
      appendFileSync(
        DEBUG_LOG_FILE,
        `[${new Date().toISOString()}] MODULATE baseline=${bl} action=none reason=${tier.reason}\n`,
      );
    }
  } catch {
    /* 日志失败忽略：不引入新崩溃点 */
  }
}

// ── ③ thought notes（阶段 2 思考链，2026-08-13）──────────────────────────
// 纯函数 + 文件读，零依赖、fail-open；热路径不加 embed 网络调用（关键词法）。

function bigramSet(text) {
  const t = String(text || "").replace(/\s+/g, "");
  const s = new Set();
  for (let i = 0; i < t.length - 1; i += 1) s.add(t.slice(i, i + 2));
  return s;
}

/** 激活度 = 对称双向 Jaccard：|q∩th| / |q∪th|（0..1）。
 * P1-2（审计 2026-08-14）：旧公式 coverage=hit/th.size 对 query 长度系统性
 * 有偏——短 query 的高频字对（什么/是的/的了）可伪达 0.05 阈值注入无关
 * thought（审计反例：“中午吃什么好呢”→0.050 注入“惊讶无锚点”；而相关
 * query 仅 0.037 不注入，方向反了）；对长 thought（200+ 字）短 query 的
 * 覆盖率理论上限 <0.03，标定整体失效。
 * 双向 Jaccard 的 union 项天然包含 query 长度：粒子级伪相关（1-2 个共享
 * bigram）至多 ~0.025 达不到阈值；真主题重叠（≥5 个共享 bigram ≈ 6 字
 * 真实共现）才可能触发——结构性消除“短 query 伪相关”，无需长度地板常数。
 * 比对对象 = 注入形态（≤THOUGHT_MAX_CHARS 规范化截断），与
 * buildThoughtLayer 实际注入的文本一致（长 thought 不再因全文稀释失分）。
 */
export function thoughtActivation(query, thought, maxChars = THOUGHT_ACTIVATION_CHARS) {
  const q = bigramSet(query);
  const t = String((thought && thought.text) || "").trim().replace(/\s+/g, " ");
  const th = bigramSet(t.slice(0, maxChars));
  if (q.size === 0 || th.size === 0) return 0;
  let hit = 0;
  for (const g of th) if (q.has(g)) hit += 1;
  const union = q.size + th.size - hit;
  if (union <= 0) return 0;
  return hit / union;
}

/** 读 thoughts.jsonl 最近 maxItems 条（新→旧）。缺失/损坏 → []（fail-open）。 */
export function loadRecentThoughts(maxItems = THOUGHTS_MAX_ITEMS) {
  try {
    const content = readFileSync(THOUGHTS_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean).slice(-maxItems);
    const out = [];
    for (const ln of lines) {
      try {
        const d = JSON.parse(ln);
        if (d && typeof d.text === "string" && d.text.trim()) out.push(d);
      } catch {
        /* 单行损坏跳过（fail-open） */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// R7 灰度观测（C1：INJECTED len 分布 + 回魂段截断率）：thought 注入条数 /
// 回魂段截断事件写日志（与 logMiss 同模式，日志失败绝不影响主流程）。
function logThoughtInject(n) {
  try {
    appendFileSync(DEBUG_LOG_FILE, `[${new Date().toISOString()}] THOUGHT-INJECT n=${n}\n`);
  } catch { /* 日志失败忽略：不引入新崩溃点 */ }
}
function logThoughtFallback(from, to) {
  try {
    appendFileSync(DEBUG_LOG_FILE, `[${new Date().toISOString()}] THOUGHT-FALLBACK ${from}->${to}\n`);
  } catch { /* 日志失败忽略：不引入新崩溃点 */ }
}

/**
 * 按激活度取 1-2 条 thought（设计 §三-3；R7 灰度 2026-08-16）。规则：
 *   - act = 双向 Jaccard（P1-2，见 thoughtActivation）；echo.flagged → ×0.5
 *     （防回声降权）；unresolved → +0.02（悬案连续性小幅加成——旧 0.05 是
 *     coverage 尺度标定，Jaccard 尺度下会把 0.02 的弱相关直接推过阈值，
 *     重演伪相关，故随尺度下调）
 *   - act < cfg.thoughtActivationMin → 不注入（激活度低则不注入）
 *   - P1-2：同文本 thought 精确去重（审计：两条相同文本 thought 同时
 *     0.069/0.069 入选，thought 行 217 字里约一半是重复内容）
 *   - maxItems：R7 灰度上限（默认 THOUGHT_INJECT_MAX=2；buildSoulText 预算
 *     闸门降级时传 1）
 * 返回 [{thought, act}]（按 act 降序）。
 */
export function pickThoughts(query, thoughts, cfg, maxItems = THOUGHT_INJECT_MAX) {
  if (!Array.isArray(thoughts) || thoughts.length === 0) return [];
  const min = Number.isFinite(cfg.thoughtActivationMin)
    ? cfg.thoughtActivationMin
    : 0.05;
  const scored = [];
  const seenTexts = new Set();
  for (const t of thoughts.slice(-THOUGHTS_MAX_ITEMS)) {
    const norm = String(t.text || "").trim().replace(/\s+/g, " ");
    if (!norm || seenTexts.has(norm)) continue;
    seenTexts.add(norm);
    let act = thoughtActivation(query, t);
    if (t.echo && t.echo.flagged) act *= 0.5;
    if (t.unresolved) act += 0.02;
    scored.push({ thought: t, act });
  }
  scored.sort((a, b) => b.act - a.act);
  return scored
    .filter((s) => s.act >= min)
    .slice(0, Math.max(THOUGHT_INJECT_MIN, maxItems));
}

/** 组装 thought 注入行（≤THOUGHT_MAX_CHARS/条，1-2 条；无命中 → null）。 */
export function buildThoughtLayer(query, thoughts, cfg, maxItems = THOUGHT_INJECT_MAX) {
  const picked = pickThoughts(query, thoughts, cfg, maxItems);
  if (picked.length === 0) return null;
  const bits = picked.map(({ thought }) => {
    let text = String(thought.text || "").trim().replace(/\s+/g, " ");
    if (text.length > THOUGHT_MAX_CHARS) text = `${text.slice(0, THOUGHT_MAX_CHARS)}…`;
    const topic = thought.topic ? `【${thought.topic}】` : "";
    return `${topic}${text}`;
  });
  return `thought:${bits.join("｜")}`;
}

/** 行动层（阶段 4，设计 v1.0 §三-6）：把**激活的 thought** 携带的行动意向
 * （dandan 四问：该做什么/愿意做什么/想做什么/值不值得对抗体力限制 + 分级）
 * 格式化为注入行（≤120 字）。无 action 字段/无 what → null（调用方回退占位）。
 * ★ 边界：只展示意向，不产生任何执行动作（思考链只产出不行动）。
 */
export function buildActionLayer(thought) {
  const a = thought && typeof thought === "object" ? thought.action : null;
  if (!a || typeof a !== "object") return null;
  const what = String(a.what || "").trim().replace(/\s+/g, " ");
  if (!what) return null;
  const bits = [`该做:${what}`];
  if (typeof a.want === "string" && a.want.trim()) {
    bits.push(`想:${a.want.trim().replace(/\s+/g, " ")}`);
  }
  if (typeof a.willing === "string" && a.willing.trim()) {
    bits.push(`愿:${a.willing.trim().replace(/\s+/g, " ")}`);
  }
  if (typeof a.worth_against_energy === "boolean") {
    bits.push(a.worth_against_energy ? "值得对抗体力" : "不值得对抗体力");
  } else if (typeof a.worth_against_energy === "string" && a.worth_against_energy.trim()) {
    bits.push(`体力权衡:${a.worth_against_energy.trim().replace(/\s+/g, " ")}`);
  }
  const status = a.status === "executable" ? "可执行意向" : "暂缓意向";
  let out = `[行动] ${status}：${bits.join("；")}`;
  // 预算纪律：≤120 字（截断标记“…”预留 1 字，实际内容 ≤119）
  if (out.length > 120) out = `${out.slice(0, 119)}…`;
  return out;
}

/**
 * 把 /soul 响应整理为【回魂】段（≤maxChars，默认 200）。
 * 阶段 1 六层：① 状态块 + ② 景观叙事 + ③ thought + 自述/最近（保留）。
 * 阶段 2 P1-1：② 景观叙事真实读 /landscape（landscapeData 透传，读数派生）；
 * ③ thought R7 灰度：1 条默认 + 余量升 2（预算闸门：2 条超 maxChars → 降 1 条）。
 * 格式：`[回魂] 自述:… / 状态:熵0.95 惊讶0.11 目的0.92 / 景观:… / thought:… / 最近:…`
 * 无有效字段/异常结构 → 返回 null。
 *
 * @param {object|null} reactData 体验层 A：/react 响应（可选）。在场时把
 *   记忆状态解读段扩权为景观叙事（设计 v1.1 §3.4：解读段放截断保活区，永不先截）。
 * @param {object|null} landscapeData 阶段 2 P1-1：/landscape/{sid} 响应（可选）。
 *   在场时景观叙事走读数派生（主导盆地/激活拓扑/σ 层级/漂移），缺失回退旧行为。
 */
export function buildSoulText(data, maxChars = SOUL_MAX_CHARS, reactData = null, query = "", cfg = null, pickedThoughts = null, landscapeData = null) {
  // data 为 null = 未启用/请求失败（原因已在 postJson 记 MISS），此处不重复记
  if (!data || typeof data !== "object") return null;
  const parts = [];

  // 1. 自述（LMS self_ref）：去重 + 最多 2 条（蒸馏缓存会产出连续重复）
  const voices = Array.isArray(data.lms_voice)
    ? data.lms_voice.filter((v) => typeof v === "string" && v.trim())
    : [];
  const uniqVoices = [...new Set(voices.map((v) => v.trim().replace(/\s+/g, " ")))].slice(0, 2);
  if (uniqVoices.length > 0) {
    parts.push(`自述:${uniqVoices.join("｜")}`);
  }

  // 2. 状态（熵 / 惊讶 / 目的一致性 / 轮次）
  const st = data.lms_state && typeof data.lms_state === "object" ? data.lms_state : {};
  const stBits = [];
  if (typeof st.entropy_ratio === "number") stBits.push(`熵${st.entropy_ratio.toFixed(2)}`);
  if (typeof st.last_surprise === "number") stBits.push(`惊讶${st.last_surprise.toFixed(2)}`);
  if (typeof st.purpose_coherence === "number") stBits.push(`目的${st.purpose_coherence.toFixed(2)}`);
  if (typeof st.turn_count === "number") stBits.push(`轮次${st.turn_count}`);
  if (stBits.length > 0) parts.push(`状态:${stBits.join(" ")}`);

  // ② 景观叙事（阶段 2 P1-1：真实读 /landscape 读数派生，≤200 字；
  //    /landscape 缺失 → 回退 react/soul 状态派生，fail-open）
  const landscape = buildLandscapeNarrative(reactData, data, landscapeData);
  if (landscape) parts.push(landscape);

  // ③ thought notes（阶段 2 思考链，2026-08-13；R7 灰度 2026-08-16）：
  //    按"与当前对话的激活度"取 1 条默认 + 余量灰度升 2（bigram 覆盖度；
  //    echo 降权、悬案加成）；未激活不注入。cfg.thoughtEnabled=false 可整体关闭。
  //    阶段 4：pickedThoughts 可选——buildMemoryContext 已算好激活结果时
  //    直接复用（避免重复读 thoughts.jsonl + 重复打分），缺省回退自行挑选。
  //    R7 预算闸门（C1 观测点）：2 条使回魂段 >maxChars → 降为 1 条重建。
  const cfgT = cfg && typeof cfg === "object" ? cfg : {};
  if (cfgT.thoughtEnabled !== false && typeof query === "string" && query) {
    const thoughts = Array.isArray(pickedThoughts)
      ? pickedThoughts.map((p) => p.thought)
      : loadRecentThoughts();
    // 灰度：先尝试 2 条（THOUGHT_INJECT_MAX），超预算降 1 条
    let thoughtLine = buildThoughtLayer(query, thoughts, cfgT, THOUGHT_INJECT_MAX);
    if (thoughtLine) {
      parts.push(thoughtLine);
      const provisional = `[回魂] ${parts.join(" / ")}`;
      if (provisional.length > maxChars) {
        // R7 灰度降级：2 条超预算 → 1 条（回魂段永不先截，丢 thought 不丢状态）
        parts.pop();
        const oneLine = buildThoughtLayer(query, thoughts, cfgT, 1);
        if (oneLine) parts.push(oneLine);
        logThoughtFallback(2, 1);
      } else {
        logThoughtInject(thoughtLine.includes("｜") ? 2 : 1);
      }
    }
  }

  // 4. 最近（沙漏最新记忆）：去重 + 最多 2 条（放 thought 之后=截断时先丢）
  const recents = Array.isArray(data.recent)
    ? data.recent.filter((r) => r && typeof r.text === "string" && r.text.trim())
    : [];
  const uniqRecents = [];
  const seenR = new Set();
  for (const r of recents) {
    const t = r.text.trim().replace(/\s+/g, " ");
    if (!seenR.has(t)) { seenR.add(t); uniqRecents.push(t); }
    if (uniqRecents.length >= 2) break;
  }
  if (uniqRecents.length > 0) {
    parts.push(`最近:${uniqRecents.join("｜")}`);
  }

  if (parts.length === 0) {
    logMiss("soul-empty-fields"); // P0-1：有响应但无可用字段
    return null;
  }
  let out = `[回魂] ${parts.join(" / ")}`;
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

/**
 * 把 /recall 响应整理为注入文本（≤maxChars）——阶段 1 六层注入的 ④⑤⑥ 层：
 * 焦点记忆（3-5 条，Cowan 4±1）+ 质疑层 + 行动层占位。
 * 响应结构（glue_server.py 实测）：{query, count, results:[{id,text,origin,
 * scores:{text,vector,lms_activation,total}, lms:{…}}], self_ref:[自述]}
 * 无结果/异常结构 → 返回 null。
 *
 * @param {boolean} skipSelfRef 已注入【回魂】段时跳过 [记忆系统自述]（防重复）。
 * @param {object|null} reactData 体验层 A：/react 响应（可选）——质疑层的
 *   全局 precision 信号来源；缺席时质疑层仅用条目自身信号（向后兼容）。
 * @param {object|null} activatedThought 阶段 4：当前对话激活的 thought（可选，
 *   默认 null）。它的 action 字段（行动意向四问）经 buildActionLayer 注入⑥行动层；
 *   无激活 thought / 无 action → 回退占位。仅展示意向，零执行动作。
 */
export function buildContextText(data, query, maxChars, skipSelfRef = false, reactData = null, activatedThought = null) {
  if (!data || typeof data !== "object") {
    logMiss("recall-invalid-response"); // P0-1：/recall 响应结构异常
    return null;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    logMiss("recall-no-results"); // P0-1：/recall 无命中
    return null;
  }

  // ④ 焦点记忆：3-5 条（Cowan 4±1），六层衔接加权（R4，定稿 v2 §四-3）：
  //    “相关性×trust×景观激活”加权取舍（滤伪相关——Power of Noise）。
  //    相关性 = scores.total（glue 协同分）；trust = ⚠️置信 标注（parseConfidenceTag，
  //    无标注默认 1.0）；景观激活 = scores.lms_activation（LMS 激活加权分量）。
  //    加权分 = relevance × trust × landscape_activation，降序取前 3-5 条。
  //    精确去重（同文不重复注入）。缺分字段的条目用 1.0 中性值（fail-open 不误杀）。
  const items = [];
  const seenTexts = new Set();
  for (const it of results) {
    const text = typeof it?.text === "string" ? it.text.trim().replace(/\s+/g, " ") : "";
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    const relevance = typeof it?.scores?.total === "number" ? it.scores.total : 1.0;
    const trust = parseConfidenceTag(text) ?? 1.0;
    const landscapeAct = typeof it?.scores?.lms_activation === "number"
      ? it.scores.lms_activation : 1.0;
    items.push({
      text,
      origin: typeof it?.origin === "string" && it.origin ? it.origin : "",
      score: typeof it?.scores?.total === "number" ? it.scores.total : null,
      weight: relevance * trust * landscapeAct,
    });
  }
  // 六层衔接加权（R4）：按 相关性×trust×景观激活 降序取舍（滤伪相关）
  items.sort((a, b) => b.weight - a.weight);
  const picked = items.slice(0, FOCUS_MAX_ITEMS);
  if (picked.length === 0) {
    logMiss("recall-no-usable-text"); // P0-1：命中条目均无可注入文本
    return null;
  }

  const lines = [`[记忆注入] 焦点记忆 ${picked.length} 条（按"${String(query).slice(0, 60)}"激活加权召回）：`];
  for (const [i, it] of picked.entries()) {
    // 来源 + 置信度标注 + 加权分（R4 可观测）：[origin·分total·权w]；无分时仅标来源
    const meta = it.origin
      ? `[${it.origin}${it.score !== null ? `·分${it.score.toFixed(2)}` : ""}·权${it.weight.toFixed(2)}]`
      : "";
    lines.push(`${i + 1}. ${meta} ${it.text}`);
  }

  // ⑤ 质疑层 + ⑥ 行动层（阶段 4：激活的 thought 才带行动意向；无则占位）
  const doubt = buildDoubtLayer(results, reactData);
  if (doubt) lines.push(doubt);
  const actionLine = buildActionLayer(activatedThought);
  lines.push(actionLine || "[行动] 无（暂无行动意向）");

  // ── L1 生成约束（状态调制生成 · 第一跳）──
  // 信号源 = reactData.reaction.doubt（与质疑层同源，零新 HTTP，修订 2/6）；
  // 冷启动/开关关保护（修订 5）；命令式句法护栏（修订 4）。
  // 保活（修订 3/P1-2）：约束段 unshift 到注入块**最前**（[记忆注入] 头之前）——
  // 截断链从尾到头（buildContextText 压缩条目 / composeContext 先截记忆块），
  // 头部永不触及；保活优先级：回魂段（永不先截）> 约束段 > 其余。lost-in-the-middle
  // 位置纪律：约束是"该如何生成"的指令，放最显眼处。
  // 语义分离：质疑层=描述状态（在怀疑什么）；约束段=命令式规则（该如何生成）。
  const constraint = buildModulationConstraint(reactData?.reaction?.doubt);
  if (constraint) lines.unshift(constraint);
  // S3 链路日志（修订 7）：baseline 值 → 调制动作 → 生效（每轮可查）
  logModulate(modulationTier(reactData?.reaction?.doubt), constraint);

  // 反思回流：附加记忆系统最近自述（LMS self_ref 产物）；
  // 回魂段已含自述时跳过，避免重复占用上下文预算。
  if (!skipSelfRef) {
    const voices = Array.isArray(data.self_ref) ? data.self_ref.filter(v => typeof v === "string" && v.trim()) : [];
    if (voices.length > 0) {
      lines.push(`[记忆系统自述] ${voices.join(" / ")}`);
    }
  }

  let joined = lines.join("\n");
  if (joined.length > maxChars) {
    // 六层保结构截断（阶段 1）：先压缩条目文本，保留头部/质疑/行动层完整
    // （lost-in-the-middle：关键结构不埋在截断区；⑤⑥ 层不能先截）。
    // 目标 = maxChars - 2：留安全边距，避免 composeContext 的标记截断
    // （其 memBudget = maxChars - soul - 2，标记预留 5 字）恰好压线触发。
    const target = maxChars - 2;
    const itemIdxs = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\d+\. /.test(lines[i])) itemIdxs.push(i);
    }
    if (itemIdxs.length > 0) {
      const origLines = lines.slice();
      const overflow = joined.length - target;
      // 每轮从原行多砍 1 字（"…" 补回 1 字，净减 per-1）；短条目触底
      // （保留行号+来源/置信度前缀 ≥20 字）后由后续轮次继续压长条目。
      let per = Math.ceil(overflow / itemIdxs.length);
      for (let round = 0; round < 10 && joined.length > target; round += 1) {
        per += 1;
        for (const i of itemIdxs) {
          const line = origLines[i];
          const cut = Math.min(Math.max(line.length - 20, 0), per);
          if (cut > 0) lines[i] = `${line.slice(0, line.length - cut)}…`;
        }
        joined = lines.join("\n");
      }
    }
    if (joined.length > maxChars) {
      // 极端兜底（条目全部触底仍超限）：整体截断（从头保留——约束段在头部
      // 不受影响；若极端情形仍被吃掉，记 MODULATE-TRUNCATED 事件日志，
      // 调制静默失效必须可观测，修订 3/P1-2）。
      joined = `${joined.slice(0, maxChars)}…（截断）`;
      if (constraint && !joined.includes("[生成约束]")) {
        logModulate(modulationTier(reactData?.reaction?.doubt), constraint, true);
      }
    }
  }
  return joined;
}

/**
 * 组装最终注入文本：【回魂】段在前，[记忆注入] 段在后，总量 ≤maxChars。
 * 两者皆空 → null。
 *
 * 截断保活（体验层 A）：解读段（在 soulText 内）永不先截——先截记忆块
 * （设计 v1.1 §3.4 申报项）；记忆块截完后仍超限才整体截断（极端兜底）。
 */
export function composeContext(soulText, memoryText, maxChars) {
  const blocks = [];
  if (typeof soulText === "string" && soulText) blocks.push(soulText);
  if (typeof memoryText === "string" && memoryText) blocks.push(memoryText);
  if (blocks.length === 0) {
    logMiss("compose-empty"); // P0-1：回魂与记忆块皆为空
    return null;
  }
  let joined = blocks.join("\n\n");
  if (joined.length > maxChars) {
    // 截断保活：解读段在 soulText 内，永不先截——先截记忆块
    if (typeof soulText === "string" && soulText
        && typeof memoryText === "string" && memoryText) {
      const keep = soulText.length + 2; // "\n\n" 分隔符
      const memBudget = Math.max(0, maxChars - keep);
      let memCut = memoryText;
      if (memCut.length > memBudget) {
        // “…（截断）”为 5 字符，预留 5 保证最终 ≤maxChars
        memCut = memBudget > 5
          ? `${memCut.slice(0, memBudget - 5)}…（截断）`
          : memCut.slice(0, memBudget);
      }
      joined = `${soulText}\n\n${memCut}`;
    }
    if (joined.length > maxChars) joined = `${joined.slice(0, maxChars)}…（截断）`;
  }
  return joined;
}

/**
 * 主入口：查询（当前消息前 200 字）→ 限流 → 并行召回（/soul + /recall）→ 组装注入文本。
 * 返回注入文本（字符串）或 null（不注入）。绝不抛异常。
 *
 * 回魂：/soul 快照固定附带【回魂】段（放记忆块之前）；即使 /recall 无命中，
 * 只要 /soul 有内容也照常注入 —— 会话醒来默认回到自己的状态。
 */
export async function buildMemoryContext(prompt, pluginConfig) {
  const cfg = resolveConfig(pluginConfig);
  if (!cfg.enabled) {
    logMiss("plugin-disabled"); // P0-1
    return null;
  }
  // 召回L1-a（2026-08-11）：query 净化 —— 剥离 openclaw 元数据块/时间戳/
  // 子代理模板，取用户真实正文前 QUERY_MAX_CHARS 字；纯模板/心跳 → null 不注入；
  // 净化异常回落原逻辑（fail-open）。
  const query = extractQueryText(prompt);
  if (!query) {
    logMiss("empty-query"); // P0-1
    return null;
  }

  const now = Date.now();
  if (now - lastCallAt < cfg.minIntervalMs) {
    // 限流语义微调（体验层 A，设计 v1.1 §3.4 申报项）：
    // 现"距上次 <2s 直接跳过"改为"跳过记忆块重路径（/soul+/recall），
    // 但仍尝试轻量 /react 解读段注入（≤150 字）"——密集对话轮
    // "大脑每轮说话"更连续；轻量注入不更新 lastCallAt（重路径限流不变）。
    const light = await fetchReact(cfg, query);
    const lightText = buildLightInjection(light, cfg);
    if (lightText) {
      logInjectedLight(lightText); // 观测点（审计建议 2）：INJECTED-light 计数
      return lightText;
    }
    logMiss(`rate-limited elapsed=${now - lastCallAt}ms < minIntervalMs=${cfg.minIntervalMs}ms`); // P0-1：限流（轻量解读也失败）
    return null;
  }
  if (inflight) {
    logMiss("inflight-reentry"); // P0-1：防重入
    return null;
  }
  inflight = true;
  lastCallAt = now;
  try {
    // 阶段 2 P1-1：四路并行——/react（实时反应，k=0 轻量）+ /soul（回魂，保留）
    // + /recall（记忆块，保留）+ /landscape（景观读数，P1-1 主缺口修复）。
    // 任一失败各自 fail-open，不拖慢其他路。
    const [reactData, soulData, recallData, landscapeData] = await Promise.all([
      fetchReact(cfg, query),
      cfg.soulEnabled ? fetchSoul(cfg) : Promise.resolve(null),
      recallFromGlue(query, cfg),
      cfg.landscapeEnabled ? fetchLandscape(cfg) : Promise.resolve(null),
    ]);

    // 阶段 4：激活 thought 一次挑选、两处复用（③ thought 层 + ⑥ 行动层）——
    // 避免重复读 thoughts.jsonl 与重复打分；激活的 thought 才带行动意向
    // （设计 §三-6：未激活不注入）。thoughtEnabled=false 时零文件读（整体关闭）。
    let pickedThought = null;
    let picked = [];
    if (cfg.thoughtEnabled !== false) {
      const thoughts = loadRecentThoughts();
      picked = pickThoughts(query, thoughts, cfg);
      pickedThought = picked.length > 0 ? picked[0].thought : null;
    }
    // 【回魂】段（≤soulMaxChars），优先于记忆块；解读段经 reactData 追加；
    // 阶段 2：query + cfg 透传（③ thought notes 激活度筛选需要）；
    // P1-1：landscapeData 透传（② 景观叙事真实读 /landscape 读数派生）。
    const soulText = buildSoulText(soulData, cfg.soulMaxChars, reactData, query, cfg, picked, landscapeData);
    // P1-4（审计 2026-08-14）：注入预算余量保护。旧实现按 maxChars 顶格执行
    // （实测 798/800，余量 2 字——回魂段 301 必截、最近记忆必丢）。现在：
    //   ① 总量按 maxChars-COMPOSE_MARGIN=760 执行（40 字安全余量）；
    //   ② thought ≤60 字/条 + 去重 + 单条上限（回魂段内「最近」不再被挤掉）；
    //   ③ 回魂段保护优先级不变：[回魂] 永不先截（composeContext 先截记忆块）。
    const injectBudget = Math.max(200, cfg.maxChars - COMPOSE_MARGIN);
    // 记忆块预算 = 注入预算 - 回魂段 - "\n\n" 分隔符（与 composeContext 的
    // keep=soulText.length+2 对齐，避免 compose 二次截断吃掉尾部结构层）
    const memoryBudget = Math.max(200, injectBudget - (soulText ? soulText.length + 2 : 0));
    // reactData 透传给 buildContextText：质疑层需要全局 precision 信号
    const memoryText = buildContextText(recallData, query, memoryBudget, Boolean(soulText), reactData, pickedThought);

    return composeContext(soulText, memoryText, injectBudget);
  } catch (err) {
    logMiss(`unexpected ${err instanceof Error ? err.message : String(err)}`); // P0-1：兜底
    return null;
  } finally {
    inflight = false;
  }
}
