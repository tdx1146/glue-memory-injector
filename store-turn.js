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
//
// 人机标记（2026-09-19，与 scripts/session_store.py 旁路同构）：
//   真实对话走的是本路（agent_end → glue /store-turn → LMS /store → archive），
//   而旁路 session_store.py 扫的 DSH 会话没有新回合（存 0 跳过 0）。
//   ⇒ 用户回合 payload 带 source_kind='user'（人类原话）；INTERSESSION 模式 B 与
//     机器注入/自造的「用户回合」（think_loop 自造提示词、信箱唤醒信…）带 'agent'
//     （非人类原话，防自指污染回流）；self 伴生条由 lms-api 恒记 'agent'。
//   开关 config.storeTurn.sourceKindEnabled（默认 true）；关掉 = 不发该字段 =
//   旧 wire 形状零变化。判据见 docs/plan_判据统一-source_kind为准-20260919.md §3.2。
//   2026-09-20 修：INTERSESSION 模式 B 的 userInput 已置空，写契约（glue/lms-api
//   /store）必拒（400/422）⇒ 旧代码每次必 400、从未落库。现改为 handleAgentEnd
//   直接跳过（reason=intersession），不发空 user_input；模式 B 不再产生 400。

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stripInboundMetadata } from "./memory-recall.js";

const GLUE_DEFAULT_URL = "http://127.0.0.1:19000";
// 写超时校准（2026-09-20 修复单，M-3 重标）：旧 12s 基于“/store 内部 3×跨机
// embed 最坏 ≈6.75s”的旧假设——实测不成立：手机 bge-m3 嵌入 ≈4.5–6.5ms/字，
// 整回合文本（user+assistant，可达数千字）单次 embed 即 8–17s，+process ~3.4s
// ⇒ /store 常态 11–17s，旧 12s 熔断必中。glue 侧 lms_timeout 同步 10s→25s。
// 28s = 25s(glue) + 3s 余量，仍 < 30s hook 预算（index.js AGENT_END_TIMEOUT_MS）。
const STORE_TIMEOUT_MS = 28000;
const RATE_LIMIT_MS = 3000;       // 两次自动写入最小间隔（防写放大）
const FINGERPRINT_WINDOW_MS = 60000;
const FINGERPRINT_CAP = 100;
const USER_MAX_CHARS = 2000;
const OUTPUT_MAX_CHARS = 20000;
const SENDER = "openclaw-agent_end";
// 人机标记值（2026-09-19）：写侧声明的来源种类——'user'=人类原话 / 'agent'=机器。
// 与 session_store.py 的 SOURCE_KIND_USER 同值（glue/lms-api/archive 全线已支持）。
const MARK_USER = "user";
const MARK_AGENT = "agent";
// 开关 env fallback（config.storeTurn.sourceKindEnabled 优先；未设时读本 env，
// 仅 "0"/"false" 关，缺省开——与 GLUE_STORE_TURN_ENABLED 同一「config 优先 + env 兜底」模式）。
const STORE_SOURCE_KIND_ENV = "GLUE_STORE_SOURCE_KIND_ENABLED";
// 机器注入的「用户回合」识别（2026-09-19）：OpenClaw 侧有多条把机器文本当 user
// 消息注入/自造的通道，它们在 archive 里都进了 external 条目（实测：think_loop
// 自造提示词 284 条、信箱唤醒信 96 条，另有 wake-bridge / 梦中醒来 / 回魂 等）——都不是
// 人类原话。若一律标 'user'，判据侧（understand_poll §3.2：'user'⇒ALLOW）会把机器注入
// 当人话放行（正是 P0-7 要防的自指污染）。故这些形状标 'agent'。
// 原则：只认**已在档案里实测**的形状；宁漏不误伤真人（漏标代价：漏一轮重理解，
// 存量仍走旧逻辑、不回归）。长期解：DSH 的 source.kind 随数据流下来（四妹 §27D）。
const _MACHINE_USER_TURN_RES = [
  /你是思考链的【后台思考者】/, // think_loop 调度器自造提示词（THINK_LOOP_FINGERPRINT）
  /📬\s*【信箱/, // mailbox-poll 唤醒信（chat.send 注入）
  /【信箱·留言/, // mailbox-injector 定向送达段
  /\[wake-bridge\]/i, // wake-bridge 注入
  /【梦中醒来】/, // 自主醒来注入
];
function isMachineInjectedUserTurn(text) {
  const t = String(text || "");
  return _MACHINE_USER_TURN_RES.some((re) => re.test(t));
}
const STORE_LOG_FILE = "/tmp/glue-store-debug.log";
// C-18 断流告警状态文件（2026-08-13 事故 P0 补洞）：每轮 agent_end（含所有 SKIP 分支）
// 原子更新，供契约 C-18 判定"有对话但写侧断流"。原子写=临时文件+rename，异常 fail-open。
const STORE_STATE_FILE = "/tmp/glue-store-state.json";
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
 * C-18 状态文件原子更新（读-改-写 + 临时文件 rename）。
 * 每次 handleAgentEnd 进入都会刷新 last_agent_end_at；SKIP 分支写 last_skip_reason；
 * STORE-OK 写 last_store_ok_at 并清 last_skip_reason。任何异常吞掉 fail-open，不影响主流程。
 * @param {object} [opts]
 * @param {string} [opts.agentEndAt] ISO——本轮 agent_end 进入时刻
 * @param {string} [opts.storeOkAt] ISO——仅 STORE-OK 时传
 * @param {string|null} [opts.skipReason]——SKIP 分支原因；null 表示清空（成功轮）
 */
function updateStoreState({ agentEndAt = null, storeOkAt = null, skipReason = undefined } = {}) {
  try {
    let state = {};
    try {
      state = JSON.parse(readFileSync(STORE_STATE_FILE, "utf8"));
    } catch {
      state = {}; // 首次写入/损坏 → 从零开始
    }
    if (agentEndAt) state.last_agent_end_at = agentEndAt;
    if (storeOkAt) state.last_store_ok_at = storeOkAt;
    if (skipReason !== undefined) state.last_skip_reason = skipReason;
    state.updated_at = new Date().toISOString();
    const tmp = `${STORE_STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, STORE_STATE_FILE);
  } catch {
    /* fail-open：状态文件写失败不影响写侧主流程 */
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
    // 人机标记开关（2026-09-19）：config 显式值优先，未设时 env 兜底（仅 "0"/"false"
    // 关）。缺省开 = 与 session_store.py 的 STORE_SOURCE_KIND 默认一致。
    sourceKindEnabled:
      st.sourceKindEnabled === true
        ? true
        : st.sourceKindEnabled === false
          ? false
          : !["0", "false"].includes(env && env[STORE_SOURCE_KIND_ENV]),
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
  const payload = {
    session_id: sessionId,
    user_input: String(turn.userInput || "").slice(0, cfg.userMaxChars),
    llm_output: String(turn.assistantText || "").slice(0, cfg.outputMaxChars),
    sender: SENDER,
  };
  // 人机标记（2026-09-19）：真实对话这条路也声明来源种类（与旁路 session_store
  // 同构），让下游重理解层不必再猜"谁是人才"（判据见规格 §3.2）。
  //   · 普通用户回合 ⇒ 'user'（人类原话）
  //   · INTERSESSION 模式 B（userInput 已置空、只留自述段）⇒ 'agent'（机器产出）
  // 关掉开关 ⇒ 不发该字段（旧 wire 形状零变化）。
  if (cfg.sourceKindEnabled) {
    payload.source_kind =
      turn.modeB || isMachineInjectedUserTurn(turn.userInput) ? MARK_AGENT : MARK_USER;
  }
  return payload;
}

/**
 * 调 glue /store-turn（POST，AbortSignal=timeoutMs 默认 28s，2026-09-20 重标）。
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
    // C-18 状态文件：每轮 agent_end 进入即刷新 last_agent_end_at（含后续所有 SKIP 分支）
    updateStoreState({ agentEndAt: new Date().toISOString(), skipReason: null });
    const cfg = resolveStoreConfig(
      event?.context?.pluginConfig ?? api?.pluginConfig,
      env,
    );
    const runId =
      typeof ctx?.runId === "string" && ctx.runId ? ctx.runId : "no-runid";
    if (!cfg.enabled) {
      logStore("STORE-SKIP", `reason=plugin-disabled run=${runId}`);
      updateStoreState({ skipReason: "plugin-disabled" });
      return;
    }

    // 会话白名单（只写 main 脑）
    // 2026-08-13 修复：固定写 main 会话（与读侧 /recall 一致）。
    // 根因：OpenClaw 会话重置后 ctx.sessionId 变为 UUID（b9782e3b…），不在
    // sessionIds 白名单 → 写侧断流 10 小时（8/13 实测全 STORE-SKIP reason=session）。
    // 设计意图本就是"只写 main 脑白名单会话"（见文件头注释），ctx.sessionId
    // 易变不可依赖；写侧固定 main，与读侧/白名单天然一致。
    const sid = "main";
    if (!cfg.sessionIds.includes(sid)) {
      logStore("STORE-SKIP", `reason=session sid=${sid} run=${runId}`);
      updateStoreState({ skipReason: "session" });
      return;
    }

    // 防污染四闸：①心跳（run 级信号）
    if (ctx?.trigger === "heartbeat") {
      logStore("STORE-SKIP", `reason=heartbeat run=${runId}`);
      updateStoreState({ skipReason: "heartbeat" });
      return;
    }
    // ②子代理（SUBAGENT-SKIP 先例，sessionKey 含 subagent 段）
    if (typeof ctx?.sessionKey === "string" && /(^|:)subagent[:.]/i.test(ctx.sessionKey)) {
      logStore("STORE-SKIP", `reason=subagent sessionKey=${String(ctx.sessionKey)} run=${runId}`);
      updateStoreState({ skipReason: "subagent" });
      return;
    }
    // ⑦非主 agent 不写（C-18 匹配层，2026-08-13）：sessionKey 不是 agent:main:* 前缀
    // → 非主会话（多用户/其他 agent 上下文）一律不写，防污染 main 脑。
    // 实测格式：主会话=agent:main:轻如烟，子代理=agent:main:subagent:*（均以 agent:main: 开头，
    // 不误拦）；子代理由 ② 闸先拦。sessionKey 缺省 → fail-open 不拦（沿用 ② 的缺省策略）。
    if (
      typeof ctx?.sessionKey === "string" &&
      ctx.sessionKey &&
      !/^agent:main:/.test(ctx.sessionKey)
    ) {
      logStore("STORE-SKIP", `reason=not-main-agent sessionKey=${String(ctx.sessionKey)} run=${runId}`);
      updateStoreState({ skipReason: "not-main-agent" });
      return;
    }
    // ⑥cron/注入
    if (ctx?.jobId || ctx?.trigger === "cron") {
      logStore("STORE-SKIP", `reason=cron run=${runId}`);
      updateStoreState({ skipReason: "cron" });
      return;
    }
    // ④失败/中止轮
    if (event?.success === false) {
      logStore("STORE-SKIP", "reason=failed-turn");
      updateStoreState({ skipReason: "failed-turn" });
      return;
    }

    // 消息级提取（含 ③模板闸 / INTERSESSION-EXTRACT 模式 B / 无内容轮）
    const turn = extractTurnFromMessages(event?.messages, ctx);
    if (turn.skip) {
      logStore("STORE-SKIP", `reason=${turn.skip} run=${runId}`);
      updateStoreState({ skipReason: turn.skip });
      return;
    }

    // 模式 B（INTERSESSION 回灌轮）→ 跳过，不发 /store（2026-09-20 修）。
    // WHY：模式 B 的 userInput 已被置空（M-4：子代理报告全文不以「用户:」身份
    // 入库），而写契约要求 user_input 非空——glue /store 见空值直接 `400
    // "user_input 必填"`（实测探针），lms-api /store 见缺字段 `422`。
    // ⇒ 旧代码执意发空 user_input，每次必 400、从未落库（零回归可证：archive
    // 里无一行来自本路）；且这条是子代理回报回声（源头 run 已被子代理闸跳过），
    // 本就不该以 external 条目污染检索面（与四闸同旨，防自指回流）。
    // 收敛：机器产出回声不再冲写。若非人类原话也想入库，须由 lms-api 侧
    // 另行扩展写契约（另单），不在插件侧造假 user_input。
    if (turn.modeB) {
      logStore("STORE-SKIP", `reason=intersession run=${runId}`);
      updateStoreState({ skipReason: "intersession" });
      return;
    }

    // 指纹去重（M-2：同 runId + 内容哈希双键，防嵌入式重试循环多 fire）
    const fpKey = `${runId}\x00${turn.turnKey}`;
    if (fingerprintHas(fpKey)) {
      logStore("STORE-DEDUP", `plugin-fingerprint run=${runId}`);
      updateStoreState({ skipReason: "dedup" });
      return;
    }

    // 限流（防写放大）
    const now = Date.now();
    if (now - lastStoreOkAt < cfg.minIntervalMs) {
      logStore("STORE-SKIP", `reason=rate-limit elapsed=${now - lastStoreOkAt}ms run=${runId}`);
      updateStoreState({ skipReason: "rate-limit" });
      return;
    }

    const payload = buildStorePayload(turn, cfg, sid);
    const result = await storeTurnFromGlue(cfg, payload);
    if (result.ok) {
      // 指纹只在 2xx 后记录（失败不记 → 同 run 后续 fire 可重试，L2 幂等兜底防双写）
      fingerprintSet(fpKey);
      lastStoreOkAt = Date.now();
      // C-18：仅 STORE-OK 更新 last_store_ok_at 并清 skip 原因
      updateStoreState({ storeOkAt: new Date().toISOString(), skipReason: null });
      const d = result.data || {};
      if (d.stored === true) seq += 1;
      // M-1 判据 3 数据源：stored/dedup_hit 由 /store 响应透传（只有真写入才 stored=true）；
      // seq=插件侧独立计数器（stored=true 时 +1，三重一致）
      logStore(
        "STORE-OK",
        `session=${sid} turn=${String(d.turn_count)} stored=${String(d.stored)} ` +
          `seq=${seq} core_chars=${String(d.core_chars)} gray=${String(d.gray)} ` +
          `mark=${String(payload.source_kind ?? "")} ` +
          `dedup=${String(d.dedup_hit)} run=${runId}`,
      );
    } else {
      // 判据 2 分桶：502（LMS 不可达=真失败）/ timeout（embed 慢=环境）/ 其他
      logStore("STORE-FAIL", `status=${result.status} mark=${String(payload.source_kind ?? "")} run=${runId}`);
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
