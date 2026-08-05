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

const GLUE_DEFAULT_URL = "http://127.0.0.1:19000";
const FETCH_TIMEOUT_MS = 4000;   // 单次 HTTP 超时（远小于 hook 15s 预算）
const QUERY_MAX_CHARS = 200;     // 查询取当前用户消息前 200 字
const SOUL_MAX_CHARS = 150;      // 【回魂】段字数上限（2026-08-05 压缩：去重+限条数，控 token）

// 模块级限流状态（进程内共享，跨会话生效）
let lastCallAt = 0;
let inflight = false;

export function resolveConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  return {
    enabled: cfg.enabled !== false,
    glueUrl: typeof cfg.glueUrl === "string" && cfg.glueUrl ? cfg.glueUrl : GLUE_DEFAULT_URL,
    k: Number.isFinite(cfg.k) ? Math.max(1, Math.min(20, Math.floor(cfg.k))) : 8,
    minIntervalMs: Number.isFinite(cfg.minIntervalMs)
      ? Math.max(0, Math.floor(cfg.minIntervalMs))
      : 2000,
    maxChars: Number.isFinite(cfg.maxChars)
      ? Math.max(200, Math.min(4000, Math.floor(cfg.maxChars)))
      : 1500,
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

async function postJson(url, body, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
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
  return postJson(`${cfg.glueUrl}/recall`, { query, k: cfg.k });
}

/**
 * 调用胶水层 /soul（POST，JSON）—— 回魂快照（自述+状态+最近记忆）。
 * 只读聚合端点，无副作用；任何异常/超时/非 2xx 返回 null（fail-open）。
 */
export async function fetchSoul(cfg) {
  return postJson(`${cfg.glueUrl}/soul`, { limit: 3, recent_n: 3 });
}

/**
 * 把 /soul 响应整理为【回魂】段（≤maxChars，默认 300）。
 * 格式：`[回魂] 自述:… / 状态:熵0.95 惊讶0.11 目的0.92 / 最近:…`
 * 无有效字段/异常结构 → 返回 null。
 */
export function buildSoulText(data, maxChars = SOUL_MAX_CHARS) {
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

  // 3. 最近（沙漏最新记忆）：去重 + 最多 2 条
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

  if (parts.length === 0) return null;
  let out = `[回魂] ${parts.join(" / ")}`;
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

/**
 * 把 /recall 响应整理为注入文本（≤maxChars）。
 * 响应结构（glue_server.py 实测）：{query, count, results:[...], self_ref:[自述]}
 * 无结果/异常结构 → 返回 null。
 *
 * @param {boolean} skipSelfRef 已注入【回魂】段时跳过 [记忆系统自述]（防重复）。
 */
export function buildContextText(data, query, maxChars, skipSelfRef = false) {
  if (!data || typeof data !== "object") return null;
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) return null;

  const lines = [`[记忆注入] 按"${String(query).slice(0, 60)}"召回 ${results.length} 条相关记忆：`];
  for (const [i, it] of results.entries()) {
    const text = typeof it?.text === "string" ? it.text.trim().replace(/\s+/g, " ") : "";
    if (!text) continue;
    const origin = typeof it?.origin === "string" && it.origin ? `[${it.origin}]` : "";
    lines.push(`${i + 1}. ${origin} ${text}`);
  }
  if (lines.length === 1) return null;

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
    joined = `${joined.slice(0, maxChars)}…（截断）`;
  }
  return joined;
}

/**
 * 组装最终注入文本：【回魂】段在前，[记忆注入] 段在后，总量 ≤maxChars。
 * 两者皆空 → null。
 */
export function composeContext(soulText, memoryText, maxChars) {
  const blocks = [];
  if (typeof soulText === "string" && soulText) blocks.push(soulText);
  if (typeof memoryText === "string" && memoryText) blocks.push(memoryText);
  if (blocks.length === 0) return null;
  let joined = blocks.join("\n\n");
  if (joined.length > maxChars) joined = `${joined.slice(0, maxChars)}…（截断）`;
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
  if (!cfg.enabled) return null;
  const query = typeof prompt === "string" ? prompt.trim().slice(0, QUERY_MAX_CHARS) : "";
  if (!query) return null;

  const now = Date.now();
  if (now - lastCallAt < cfg.minIntervalMs) return null; // 限流
  if (inflight) return null;                              // 防重入
  inflight = true;
  lastCallAt = now;
  try {
    const [soulData, recallData] = await Promise.all([
      cfg.soulEnabled ? fetchSoul(cfg) : Promise.resolve(null),
      recallFromGlue(query, cfg),
    ]);

    // 【回魂】段（≤soulMaxChars），优先于记忆块
    const soulText = buildSoulText(soulData, cfg.soulMaxChars);
    // 记忆块预算 = 总量 - 回魂段已占字数（回魂段含自述时跳过 [记忆系统自述]）
    const memoryBudget = Math.max(200, cfg.maxChars - (soulText ? soulText.length : 0));
    const memoryText = buildContextText(recallData, query, memoryBudget, Boolean(soulText));

    return composeContext(soulText, memoryText, cfg.maxChars);
  } catch {
    return null;
  } finally {
    inflight = false;
  }
}
