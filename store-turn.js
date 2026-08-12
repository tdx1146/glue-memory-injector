// store-turn.js — agent_end 写侧：提取本轮对话 → glue /store-turn → LMS /store
//
// 设计：《阶段2-写侧接线设计-20260812.md》v1.1 §2（S2-1）＋锐审 M-1~M-7。
// 纯 ESM，零 OpenClaw SDK 依赖，可直接单测（仿 memory-recall.js 风格）。
//
// 2026-08-12 开关定案（config 优先 + env fallback，翻车史见下）：
//   翻车 1：openclaw.json 的 config.storeTurn 里写 {enabled:true, gray:true} → configSchema
//   白名单（storeTurn 子对象 additionalProperties:false，无 gray 字段）→ preflight 校验失败
//   → gateway 起不来。教训：gray 是 LMS 侧概念（LMS_STORE_GRAY，LMS .env，请求时读取热生效），
//   不得塞进插件 config。
//   翻车 2：曾改为 env 唯一权威（GLUE_STORE_TURN_ENABLED）→ Trim 托管下 env 注入不可靠
//   （.env 不加载、Bun.spawn env 显式传入）→ 开闸不生效，属过度修复。
//   最终定案（本文件当前行为）：
//     - 开关 = config.storeTurn.enabled（openclaw.json，schema 合法路径，白名单
//       enabled/sessionIds/minIntervalMs/userMaxChars/outputMaxChars/timeoutMs，无 gray）：
//       true → 开；false → 关（显式关闭，env 不得覆盖）。
//     - env `GLUE_STORE_TURN_ENABLED` 仅作 fallback：config.storeTurn.enabled 未设时，
//       严格等于 "true" 才开（兼容旧注入，不引入新权威）。
//     - 灰度标记归 LMS 侧（LMS_STORE_GRAY=1 已配在 LMS .env，热生效），插件不读不传、
//       仅回显 /store 响应 d.gray；不引入 GLUE_STORE_GRAY（避免双源不一致）。
//
// 硬约束（设计 §2.1）：
//   1. 默认关：config.storeTurn.enabled 未设且 env 未设 → handler 首行跳过，
//      写侧零副作用（钩子已注册且被授予会话读取权限——碰 openclaw 运行时，G-5）。
//   2. fail-open 三重：提取异常→skip；网络异常/超时→记日志返回；钩子抛错→runner catch。
//   3. 只写 main 脑白名单会话（sessionIds 默认 ["main"]，与 LMS /store 白名单对齐）。
//   4. 绝不阻塞：自身 AbortSignal 12s（M-3）<< 30s hook 预算；绝不重试（503 不重试，C-05 先例）。
//   5. 去重：插件侧指纹（同 runId + 内容哈希 turnKey 双键，M-2）＋LMS /store 60s 幂等窗口（权威）。
//   6. 防污染四闸：心跳/子代理/cron/模板 + INTERSESSION-EXTRACT 成果提取（M-4）。

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { stripInboundMetadata } from "./memory-recall.js";

const GLUE_DEFAULT_URL = "http://127.0.0.1:19000";
// M-3 校准：/store 内部 3 次跨机 embed 常态 3.6-4.5s、最坏 ≈6.75s；
// 插件 AbortSignal 12s（glue 之上 +2s 缓冲）<< 30s hook 预算。
const STORE_TIMEOUT_MS = 12000;
const RATE_LIMIT_MS = 3000;       // 两次自动写入最小间隔（防写放大）
const FINGERPRINT_WINDOW_MS = 60000;
const FINGERPRINT_CAP = 100;
const USER_MAX_CHARS = 2000;
const OUTPUT_MAX_CHARS = 20000;
const SENDER = "openclaw-agent_end";
const STORE_LOG_FILE = "/tmp/glue-store-debug.log";
// 开关 env fallback（2026-08-12 最终定案：config.storeTurn.enabled 优先，env 仅兜底，见文件头）。
// 值必须精确为 "true"。
const STORE_TURN_ENABLED_ENV = "GLUE_STORE_TURN_ENABLED";

// 与 memory-recall.js 同源复制的净化正则（同源同判据，防污染一致；
// 复制而非导出——不触碰读侧文件，红线段落零改动）
const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const TEMPLATE_PREFIX_RE = /^\s*(?:\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\]\s*)?(?:\[Subagent (?:Context|Task)\][:\s]*|\[Inter-session message\][:\s]*)/i;
const HEARTBEAT_POLL_RE = /heartbeat\s*poll|Read HEARTBEAT\.md/i;
const SUBAGENT_BODY_RE = /You are running as a subagent|Results auto-announce to your requester|do not busy-poll for status|\[Subagent Task\]/i;
const INTERSESSION_META_ONLY_RE = /^sourceSession=/i;
const INTERSESSION_PREFIX_RE = /^\[Inter-session message\]/i;

// 插件侧独立计数器（M-1 判据 3c：seq == stored=true 行数，三重一致数据源）
let seq = 0;
// 指纹去重（M-2）：Map<runId\x00turnKey, ts>，60s 窗口 / cap 100
let fingerprint = new Map();
let lastStoreOkAt = 0;

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function logStore(kind, detail) {
  try {
    appendFileSync(STORE_LOG_FILE, `[${new Date().toISOString()}] ${kind} ${detail}\n`);
  } catch {
    /* 日志失败忽略：不引入新崩溃点 */
  }
}

/**
 * 解析 storeTurn 配置（开关 = config.storeTurn.enabled 优先 + env fallback，
 * 调优参数 = config.storeTurn 子对象）。
 * 开关优先级（2026-08-12 最终定案，防"env 注入不可靠"翻车）：
 *   1. config.storeTurn.enabled === true → 开（openclaw.json schema 合法路径）
 *   2. config.storeTurn.enabled === false → 关（显式关闭，env 不得覆盖）
 *   3. config 未设 → env GLUE_STORE_TURN_ENABLED 严格 "true" 才开（fallback）
 * 安全默认：全部默认值即"默认关 + main 白名单 + 12s 熔断"。
 * @param {object} [pluginConfig] plugins.entries.<id>.config（storeTurn 子对象）
 * @param {object} [env] 环境变量注入点（默认 process.env；单测可传假对象）
 */
export function resolveStoreConfig(pluginConfig, env = process.env) {
  const pc = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const st = pc.storeTurn && typeof pc.storeTurn === "object" ? pc.storeTurn : {};
  let enabled;
  if (st.enabled === true) {
    enabled = true; // config 显式开（schema 合法路径）
  } else if (st.enabled === false) {
    enabled = false; // config 显式关：env 不得覆盖
  } else {
    // config 未设 → env fallback（严格 "true"）
    enabled = (env && env[STORE_TURN_ENABLED_ENV]) === "true";
  }
  return {
    enabled, // 默认关（config 未设 + env 未设/非 "true"）
    sessionIds:
      Array.isArray(st.sessionIds) && st.sessionIds.length > 0
        ? st.sessionIds.map(String)
        : ["main"],
    minIntervalMs: Number.isFinite(st.minIntervalMs)
      ? Math.max(0, Math.floor(st.minIntervalMs))
      : RATE_LIMIT_MS,
    userMaxChars: Number.isFinite(st.userMaxChars)
      ? Math.max(1, Math.floor(st.userMaxChars))
      : USER_MAX_CHARS,
    outputMaxChars: Number.isFinite(st.outputMaxChars)
      ? Math.max(1, Math.floor(st.outputMaxChars))
      : OUTPUT_MAX_CHARS,
    timeoutMs: Number.isFinite(st.timeoutMs)
      ? Math.max(1000, Math.min(30000, Math.floor(st.timeoutMs)))
      : STORE_TIMEOUT_MS,
    glueUrl:
      typeof pc.glueUrl === "string" && pc.glueUrl ? pc.glueUrl : GLUE_DEFAULT_URL,
  };
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    // 只取 TextContent 块（type==="text"）；thinking/toolCall 块天然排除
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") return extractTextFromContent(m.content);
  }
  return "";
}

function extractAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") return extractTextFromContent(m.content);
  }
  return "";
}

/**
 * 从全会话消息快照提取本轮 {userInput, assistantText, turnKey}。
 * 防污染闸（设计 §2.2/§2.3，判定顺序即代码顺序）：
 *   - ctx 级闸（心跳/子代理/cron）由 handleAgentEnd 先做（本函数只管消息级）；
 *   - 模板/心跳/空 → {skip: reason}；
 *   - INTERSESSION 回灌轮 → 模式 B 成果提取（M-4）：userInput 置空丢弃
 *     （子代理报告全文不以"用户:"身份入库），assistantText 照常提取
 *     （主代理采纳/总结段以"助手:"身份入库）。
 */
export function extractTurnFromMessages(messages, _ctx) {
  const msgs = Array.isArray(messages) ? messages : [];
  if (msgs.length === 0) return { skip: "empty" };

  let userInput = extractUserText(msgs);
  if (typeof userInput === "string") {
    try {
      userInput = stripInboundMetadata(userInput);
    } catch {
      /* fail-open：净化失败用原文本继续 */
    }
    userInput = userInput.replace(LEADING_TIMESTAMP_PREFIX_RE, "").trim();
  } else {
    userInput = "";
  }
  if (!userInput) return { skip: "empty" };

  // INTERSESSION 优先判定（TEMPLATE_PREFIX_RE 也匹配 [Inter-session message] 前缀，
  // 必须先判模式 B 再判模板跳过）
  const isInterSession =
    INTERSESSION_META_ONLY_RE.test(userInput) || INTERSESSION_PREFIX_RE.test(userInput);
  if (!isInterSession) {
    if (TEMPLATE_PREFIX_RE.test(userInput) || SUBAGENT_BODY_RE.test(userInput)) {
      return { skip: "template" };
    }
    if (HEARTBEAT_POLL_RE.test(userInput)) {
      return { skip: "heartbeat" };
    }
  }

  const assistantText = extractAssistantText(msgs);
  if (!assistantText) return { skip: "no-text" }; // 纯工具轮/think-only

  // turnKey 与 LMS /store dedup_key 同构（sha256(userInput\x00assistantText)）
  const userForKey = isInterSession ? "" : userInput;
  const turnKey = sha256(`${userForKey}\x00${assistantText}`);
  return { userInput: userForKey, assistantText, turnKey, modeB: isInterSession };
}

/**
 * 组装 /store-turn 请求 payload（sender 仅 glue 日志审计用，不转发）。
 */
export function buildStorePayload(turn, cfg, sessionId) {
  return {
    session_id: sessionId,
    user_input: String(turn.userInput || "").slice(0, cfg.userMaxChars),
    llm_output: String(turn.assistantText || "").slice(0, cfg.outputMaxChars),
    sender: SENDER,
  };
}

/**
 * 调 glue /store-turn（POST，AbortSignal=timeoutMs 默认 12s，M-3）。
 * 返回 {ok:true, data} | {ok:false, status}，status ∈ 429|503|502|<其他状态码>|timeout|network。
 *   - 429/503 → 不重试（C-05 先例：503=做梦协调/熔断降级属预期失败）
 *   - 502（glue 透传：LMS 不可达=真失败，判据 2 计入）
 *   - timeout（embed 慢=环境因素，判据 2 分桶观察不计入，M-3）
 * 任何异常 → 吞掉返回（fail-open），绝不抛错。
 */
export async function storeTurnFromGlue(cfg, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const resp = await fetch(`${cfg.glueUrl}/store-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (resp.status === 429 || resp.status === 503) {
      return { ok: false, status: String(resp.status) };
    }
    if (!resp.ok) {
      return { ok: false, status: String(resp.status) };
    }
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") {
      return { ok: false, status: "bad-json" };
    }
    return { ok: true, status: "200", data };
  } catch (err) {
    const status = err && err.name === "AbortError" ? "timeout" : "network";
    return { ok: false, status };
  } finally {
    clearTimeout(timer);
  }
}

function fingerprintHas(key) {
  const ts = fingerprint.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > FINGERPRINT_WINDOW_MS) {
    fingerprint.delete(key);
    return false;
  }
  return true;
}

function fingerprintSet(key) {
  const now = Date.now();
  // 惰性清理过期项 + cap 兜底
  if (fingerprint.size >= FINGERPRINT_CAP) {
    for (const [k, ts] of fingerprint) {
      if (now - ts > FINGERPRINT_WINDOW_MS) fingerprint.delete(k);
    }
  }
  if (fingerprint.size >= FINGERPRINT_CAP) {
    // 仍满：删最旧一条（工程兜底，Map 迭代序=插入序）
    const oldest = fingerprint.keys().next().value;
    if (oldest !== undefined) fingerprint.delete(oldest);
  }
  fingerprint.set(key, now);
}

/**
 * agent_end 钩子入口（观察型，fire-and-forget；任何异常吞掉 fail-open）。
 * 默认关：config.storeTurn.enabled 未设且 env 未设 → 首行 return（写侧零副作用）。
 * 开关 = config.storeTurn.enabled 优先 + env fallback（见 resolveStoreConfig）；
 * 配置读取双保险（G-3）：register() 时 api.pluginConfig 快照 + event.context.pluginConfig
 * 热覆盖（typed api.on 路径实际不注入 event.context.pluginConfig，防御性读取）。
 */
export async function handleAgentEnd(event, ctx, api, env = process.env) {
  try {
    const cfg = resolveStoreConfig(
      event?.context?.pluginConfig ?? api?.pluginConfig,
      env,
    );
    const runId =
      typeof ctx?.runId === "string" && ctx.runId ? ctx.runId : "no-runid";
    if (!cfg.enabled) {
      logStore("STORE-SKIP", `reason=plugin-disabled run=${runId}`);
      return;
    }

    // 会话白名单（只写 main 脑）
    const sid = typeof ctx?.sessionId === "string" && ctx.sessionId ? ctx.sessionId : "main";
    if (!cfg.sessionIds.includes(sid)) {
      logStore("STORE-SKIP", `reason=session sid=${sid} run=${runId}`);
      return;
    }

    // 防污染四闸：①心跳（run 级信号）
    if (ctx?.trigger === "heartbeat") {
      logStore("STORE-SKIP", `reason=heartbeat run=${runId}`);
      return;
    }
    // ②子代理（SUBAGENT-SKIP 先例，sessionKey 含 subagent 段）
    if (typeof ctx?.sessionKey === "string" && /(^|:)subagent[:.]/i.test(ctx.sessionKey)) {
      logStore("STORE-SKIP", `reason=subagent sessionKey=${String(ctx.sessionKey)} run=${runId}`);
      return;
    }
    // ⑥cron/注入
    if (ctx?.jobId || ctx?.trigger === "cron") {
      logStore("STORE-SKIP", `reason=cron run=${runId}`);
      return;
    }
    // ④失败/中止轮
    if (event?.success === false) {
      logStore("STORE-SKIP", "reason=failed-turn");
      return;
    }

    // 消息级提取（含 ③模板闸 / INTERSESSION-EXTRACT 模式 B / 无内容轮）
    const turn = extractTurnFromMessages(event?.messages, ctx);
    if (turn.skip) {
      logStore("STORE-SKIP", `reason=${turn.skip} run=${runId}`);
      return;
    }

    // 指纹去重（M-2：同 runId + 内容哈希双键，防嵌入式重试循环多 fire）
    const fpKey = `${runId}\x00${turn.turnKey}`;
    if (fingerprintHas(fpKey)) {
      logStore("STORE-DEDUP", `plugin-fingerprint run=${runId}`);
      return;
    }

    // 限流（防写放大）
    const now = Date.now();
    if (now - lastStoreOkAt < cfg.minIntervalMs) {
      logStore("STORE-SKIP", `reason=rate-limit elapsed=${now - lastStoreOkAt}ms run=${runId}`);
      return;
    }

    const payload = buildStorePayload(turn, cfg, sid);
    const result = await storeTurnFromGlue(cfg, payload);
    if (result.ok) {
      // 指纹只在 2xx 后记录（失败不记 → 同 run 后续 fire 可重试，L2 幂等兜底防双写）
      fingerprintSet(fpKey);
      lastStoreOkAt = Date.now();
      const d = result.data || {};
      if (d.stored === true) seq += 1;
      // M-1 判据 3 数据源：stored/dedup_hit 由 /store 响应透传（只有真写入才 stored=true）；
      // seq=插件侧独立计数器（stored=true 时 +1，三重一致）
      logStore(
        "STORE-OK",
        `session=${sid} turn=${String(d.turn_count)} stored=${String(d.stored)} ` +
          `seq=${seq} core_chars=${String(d.core_chars)} gray=${String(d.gray)} ` +
          `dedup=${String(d.dedup_hit)} run=${runId}`,
      );
    } else {
      // 判据 2 分桶：502（LMS 不可达=真失败）/ timeout（embed 慢=环境）/ 其他
      logStore("STORE-FAIL", `status=${result.status} run=${runId}`);
    }
  } catch (err) {
    // fail-open 兜底：钩子内任何异常都不外抛（runner 另有 catch）
    logStore(
      "STORE-FAIL",
      `status=unexpected reason=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// 仅供测试：重置状态
export function _resetFingerprintForTest() {
  fingerprint = new Map();
  lastStoreOkAt = 0;
  seq = 0;
}

// 仅供测试：读取状态
export function _getFingerprintStateForTest() {
  return { size: fingerprint.size, lastStoreOkAt, seq };
}
