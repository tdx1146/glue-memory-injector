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
//   ③thought notes 占位（阶段 2 思考链） ④焦点记忆 3-5 条（Cowan 4±1，
//   滤伪相关，带来源+置信度标注） ⑤质疑层（置信度/来源维度）
//   ⑥行动层占位（阶段 4）。注入块 ≤800 字硬约束。
//   数据源缺口：attractor.get_landscape() 可序列化但无 HTTP 端点（api/
//   server.py、control.py 均无 /landscape）——阶段 1 用 /react 解读段 +
//   reaction 派生 + /soul 状态兜底拼景观叙事；新端点列入阶段 2 变更申报。

import { appendFileSync } from "node:fs";

const GLUE_DEFAULT_URL = "http://127.0.0.1:19000";
// P0-1 止血：单次 HTTP 超时 4000 → 15000。慢后端（跨机 bge-m3 向量 / LMS /recall）
// 在 hook 15s 预算内允许更充分等待，此前 4s 掐死导致注入频繁静默 MISS。
const FETCH_TIMEOUT_MS = 15000;
// P0-1：/soul 回魂段走独立 4s 快路径 —— 回魂是附加价值，宁可放弃也不拖慢注入。
const SOUL_TIMEOUT_MS = 4000;
// 体验层 A：/react 实时反应同样走 4s 快路径（infer-only，k=0 轻量）。
const REACT_TIMEOUT_MS = 4000;
const QUERY_MAX_CHARS = 200;     // 查询取当前用户消息前 200 字
const SOUL_MAX_CHARS = 200;      // 【回魂】段字数上限（2026-08-05 压缩：去重+限条数；
                                 // 2026-08-13 阶段1 景观叙事扩权：解读段 ≤200 字，设计 v1.1 §三-2）
// 体验层 A：限流轮轻量解读段上限（设计 v1.1 §3.4：≤150 字）
const LIGHT_MAX_CHARS = 150;
// 阶段 1 六层注入：焦点记忆容量（Cowan 2001 注意焦点 4±1 → 3-5 条）
const FOCUS_MAX_ITEMS = 5;
// 注入块 ≤800 字硬约束（lost-in-the-middle 2307.03172：短块内位置效应可控；
// 超出走 composeContext 截断保活——[回魂] 段永不先截，先截记忆块尾部）
const INJECT_MAX_CHARS = 800;

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
  };
}

// 仅供测试：重置限流状态
export function _resetRateLimitForTest() {
  lastCallAt = 0;
  inflight = false;
}

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
 * ② 景观叙事（阶段 1 六层注入，设计 v1.1 §三-2）——解读段扩权。
 *
 * 数据源（阶段 1 可用，均经 glue 只读端点，实测字段）：
 *   - /react interpretation：LMS 解码器自然语言解读（"什么在激活"主体）
 *   - /react reaction.surprise_z：惊讶涨落方向（>1 上升 / <-1 回落 / 平稳）
 *   - /react reaction.coherence｜/soul lms_state.purpose_coherence：目的稳定性
 *   - /soul lms_state.entropy_ratio / last_surprise：解读段缺席时的派生兜底
 *
 * 缺口（阶段 2 变更申报）：attractor.get_landscape() 可序列化但无 HTTP
 * 端点（api/server.py、api/control.py 均无 /landscape）——盆地结构/激活
 * 主题竞争拿不到；新端点列入阶段 2，本阶段不新增 LMS 端点（硬约束）。
 *
 * 输出叙事（非纯数字）或 null（无任何数据源可用，fail-open）。
 */
function buildLandscapeNarrative(reactData, soulData) {
  const react =
    reactData && typeof reactData === "object" && reactData.reaction
      ? reactData.reaction
      : {};
  const st =
    soulData && typeof soulData === "object" && soulData.lms_state
      ? soulData.lms_state
      : {};
  const clauses = [];

  // 1) 解读段（自然语言，前 2 句）——"什么在激活"的主体叙事
  const interp =
    reactData && typeof reactData.interpretation === "string"
      ? reactData.interpretation.trim()
      : "";
  const interpClauses = interp.split("｜").map((s) => s.trim()).filter(Boolean);
  if (interpClauses.length > 0) {
    clauses.push(interpClauses.slice(0, 2).join("｜"));
  } else {
    // 解读段缺席（/react 失败/降级）→ 从状态数字派生基础叙事（fail-open）
    const entropyRatio = typeof react.entropy_ratio === "number"
      ? react.entropy_ratio
      : (typeof st.entropy_ratio === "number" ? st.entropy_ratio : null);
    if (entropyRatio !== null) {
      clauses.push(
        entropyRatio >= 0.8 ? "高唤醒·多模式扩散"
          : entropyRatio >= 0.4 ? "中等激活"
            : "低唤醒·单模式聚焦",
      );
    }
  }

  // 2) 惊讶涨落方向（解读段通常不覆盖；z 分优先，绝对等级兜底）
  const surpriseZ = typeof react.surprise_z === "number" ? react.surprise_z : null;
  if (surpriseZ !== null) {
    clauses.push(surpriseZ > 1 ? "惊讶上升" : surpriseZ < -1 ? "惊讶回落" : "惊讶平稳");
  } else if (typeof st.last_surprise === "number") {
    clauses.push(st.last_surprise > 20 ? "惊讶偏高" : st.last_surprise > 5 ? "惊讶中等" : "惊讶偏低");
  }

  // 3) 目的稳定性
  const coherence = typeof react.coherence === "number"
    ? react.coherence
    : (typeof st.purpose_coherence === "number" ? st.purpose_coherence : null);
  if (coherence !== null) {
    clauses.push(coherence >= 0.7 ? "目的稳定" : "目的漂移");
  }

  if (clauses.length === 0) return null;
  return `景观:${clauses.join("｜")}`;
}

/**
 * ⑤ 质疑层（阶段 1 六层注入，设计 v1.1 §三-5）——"当前在怀疑什么"。
 *
 * 阶段 1 数据源（保守表述，不臆测；无可用信号 → 返回 null 不注入行）：
 *   - 协同分 spread（results[].scores.total）：分差小 → 排序不可靠，
 *     伪相关风险（Power of Noise 2401.14887：高分无关条目最毒）
 *   - 来源维度（results[].origin）：archive=归档较旧，置信度低于活体
 *   - 全局 precision（/react reaction.precision_mean）：怀疑水位高低
 *   - 候选完全无协同分 → 显式声明"置信度不可考"（而非假装可信）
 *
 * 注：lms_activation 恒 1.0 是 glue 对 LMS 命中条目的设计值（integration_
 * service.py 4b：LMS 命中即满激活），非区分信号，不作为怀疑依据。
 */
function buildDoubtLayer(results, reactData) {
  if (!Array.isArray(results)) return null;
  const doubts = [];

  const scored = results.filter((it) => it && typeof it.scores?.total === "number");
  if (scored.length >= 2) {
    const totals = scored.map((it) => it.scores.total);
    const spread = Math.max(...totals) - Math.min(...totals);
    if (spread <= 0.05) doubts.push("协同分接近（≤0.05），伪相关风险需甄别");
  } else if (scored.length === 0) {
    doubts.push("候选未带协同分，置信度不可考（以景观激活为准）");
  }

  if (results.some((it) => it && it.origin === "archive")) {
    doubts.push("含归档条目（较旧，置信度低于活体）");
  }

  const precision = reactData?.reaction?.precision_mean;
  if (typeof precision === "number") {
    if (precision < 0.6) doubts.push(`全局precision偏低（${precision.toFixed(2)}），怀疑水位上调`);
    else if (precision > 0.9) doubts.push(`全局precision偏高（${precision.toFixed(2)}），怀疑水位偏低`);
  }

  if (doubts.length === 0) return null;
  return `[质疑] ${doubts.slice(0, 2).join("；")}`; // 预算纪律：最多 2 条信号
}

/**
 * 把 /soul 响应整理为【回魂】段（≤maxChars，默认 200）。
 * 阶段 1 六层：① 状态块 + ② 景观叙事 + ③ thought 占位 + 自述/最近（保留）。
 * 格式：`[回魂] 自述:… / 状态:熵0.95 惊讶0.11 目的0.92 / 景观:… / thought:… / 最近:…`
 * 无有效字段/异常结构 → 返回 null。
 *
 * @param {object|null} reactData 体验层 A：/react 响应（可选）。在场时把
 *   记忆状态解读段扩权为景观叙事（设计 v1.1 §3.4：解读段放截断保活区，永不先截）。
 */
export function buildSoulText(data, maxChars = SOUL_MAX_CHARS, reactData = null) {
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

  // ② 景观叙事（解读段扩权，设计 v1.1 §三-2）：描述"当前记忆状态"——
  //    什么在激活 / 惊讶涨落 / 目的稳定性（非纯数字，≤200 字预算内）。
  //    /react 失败（reactData null）时退化为从 lms_state 派生（fail-open）。
  const landscape = buildLandscapeNarrative(reactData, data);
  if (landscape) parts.push(landscape);

  // 4. 最近（沙漏最新记忆）：去重 + 最多 2 条
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
  // ③ thought notes 占位（阶段 2 思考链；本阶段仅预留结构字段，不产出内容）
  //    仅在回魂段有真实内容时追加——保持空数据 → null 的 fail-open 语义。
  parts.push("thought:无（阶段2占位）");
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
 */
export function buildContextText(data, query, maxChars, skipSelfRef = false, reactData = null) {
  if (!data || typeof data !== "object") {
    logMiss("recall-invalid-response"); // P0-1：/recall 响应结构异常
    return null;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    logMiss("recall-no-results"); // P0-1：/recall 无命中
    return null;
  }

  // ④ 焦点记忆：3-5 条（Cowan 4±1），精确去重（滤伪相关：同文不重复注入）
  const items = [];
  const seenTexts = new Set();
  for (const it of results) {
    const text = typeof it?.text === "string" ? it.text.trim().replace(/\s+/g, " ") : "";
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    items.push({
      text,
      origin: typeof it?.origin === "string" && it.origin ? it.origin : "",
      score: typeof it?.scores?.total === "number" ? it.scores.total : null,
    });
    if (items.length >= FOCUS_MAX_ITEMS) break;
  }
  if (items.length === 0) {
    logMiss("recall-no-usable-text"); // P0-1：命中条目均无可注入文本
    return null;
  }

  const lines = [`[记忆注入] 焦点记忆 ${items.length} 条（按"${String(query).slice(0, 60)}"激活加权召回）：`];
  for (const [i, it] of items.entries()) {
    // 来源 + 置信度标注（质疑层基础）：[origin·分total]；无分时仅标来源
    const meta = it.origin
      ? `[${it.origin}${it.score !== null ? `·分${it.score.toFixed(2)}` : ""}]`
      : "";
    lines.push(`${i + 1}. ${meta} ${it.text}`);
  }

  // ⑤ 质疑层 + ⑥ 行动层占位（阶段 4 实现）
  const doubt = buildDoubtLayer(results, reactData);
  if (doubt) lines.push(doubt);
  lines.push("[行动] 无（阶段4占位）");

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
      // 极端兜底（条目全部触底仍超限）：整体截断
      joined = `${joined.slice(0, maxChars)}…（截断）`;
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
    // 体验层 A：三路并行——/react（实时反应，k=0 轻量）+ /soul（回魂，保留）
    // + /recall（记忆块，保留）。任一失败各自 fail-open，不拖慢其他路。
    const [reactData, soulData, recallData] = await Promise.all([
      fetchReact(cfg, query),
      cfg.soulEnabled ? fetchSoul(cfg) : Promise.resolve(null),
      recallFromGlue(query, cfg),
    ]);

    // 【回魂】段（≤soulMaxChars），优先于记忆块；解读段经 reactData 追加
    const soulText = buildSoulText(soulData, cfg.soulMaxChars, reactData);
    // 记忆块预算 = 总量 - 回魂段 - "\n\n" 分隔符（与 composeContext 的
    // keep=soulText.length+2 对齐，避免 compose 二次截断吃掉尾部结构层）
    const memoryBudget = Math.max(200, cfg.maxChars - (soulText ? soulText.length + 2 : 0));
    // reactData 透传给 buildContextText：质疑层需要全局 precision 信号
    const memoryText = buildContextText(recallData, query, memoryBudget, Boolean(soulText), reactData);

    return composeContext(soulText, memoryText, cfg.maxChars);
  } catch (err) {
    logMiss(`unexpected ${err instanceof Error ? err.message : String(err)}`); // P0-1：兜底
    return null;
  } finally {
    inflight = false;
  }
}
