// memory-recall.js — 胶水层记忆召回逻辑（纯 ESM，零 OpenClaw SDK 依赖，可直接单测）
//
// 设计约束（Phase 5 定型，与 ARCHITECTURE-FINAL.md §插件预期一致）：
//   - fail-open：任何异常返回 null，绝不抛错、绝不阻塞主循环
//   - 限流：距上次成功召回 < minIntervalMs 直接跳过（默认 2s）；in-flight 防重入
//   - 截断：注入文本 ≤ maxChars（默认 1500 字），防爆上下文
//   - 只读：仅调 glue_server POST /recall（协同检索，无副作用）

const GLUE_DEFAULT_URL = "http://127.0.0.1:19000";
const FETCH_TIMEOUT_MS = 4000;   // 单次 HTTP 超时（远小于 hook 15s 预算）
const QUERY_MAX_CHARS = 200;     // 查询取当前用户消息前 200 字

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

/**
 * 调用胶水层 /recall（POST，JSON）。
 * 成功返回原始响应对象；任何异常/超时/非 2xx 返回 null（fail-open）。
 */
export async function recallFromGlue(query, cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${cfg.glueUrl}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, k: cfg.k }),
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
 * 把 /recall 响应整理为注入文本（≤maxChars）。
 * 响应结构（glue_server.py 实测）：{query, count, results:[...], self_ref:[自述]}
 * 无结果/异常结构 → 返回 null。
 */
export function buildContextText(data, query, maxChars) {
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

  // 反思回流：附加记忆系统最近自述（LMS self_ref 产物）
  const voices = Array.isArray(data.self_ref) ? data.self_ref.filter(v => typeof v === "string" && v.trim()) : [];
  if (voices.length > 0) {
    lines.push(`[记忆系统自述] ${voices.join(" / ")}`);
  }

  let joined = lines.join("\n");
  if (joined.length > maxChars) {
    joined = `${joined.slice(0, maxChars)}…（截断）`;
  }
  return joined;
}

/**
 * 主入口：查询（当前消息前 200 字）→ 限流 → 召回 → 组装注入文本。
 * 返回注入文本（字符串）或 null（不注入）。绝不抛异常。
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
    const data = await recallFromGlue(query, cfg);
    return buildContextText(data, query, cfg.maxChars);
  } catch {
    return null;
  } finally {
    inflight = false;
  }
}
