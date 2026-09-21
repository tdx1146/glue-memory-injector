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
// 阶段 2 步骤 4（P1-3 注入时验证链，2026-08-16，定稿 v2 §六；P1 三根因修复
// 2026-08-16 重审正式通过后灰度开启（verifyChainEnabled 默认 true，可配置关））：
//   高 stakes 可操作化（冲突检测 + STAKE_TOPICS 白名单）→ CoVe 轻量验证链
//   （草稿→独立验证→修正；独立验证防伪独立：端点/query/批次三方不同源）→
//   确认（hRepro&&eRepro + isContradictionPair 矛盾判定）写 [doubt] conflict
//   → /feed → doubt_ingest conflict 事件 → mark_labile（Nader 2000 再巩固
//   入口）；VERIFY-* 日志 provenance 防回声。零开销：无高 stakes 不触发
//   （无 HTTP、无日志、注入面零改动）。P1 修复：元数据排除 + 矛盾判定 +
//   幂等查重（详见步骤 4 段注释）。
//
// 阶段 2 步骤 2（P1-1 完整落地，2026-08-16，定稿 v2 §四）：
//   ②景观叙事主缺口修复：直调 LMS GET /landscape/{sid}（端点已存在，只读
//     fail-open）→ 读数派生叙事（主导盆地数/激活拓扑/max|σ_act|·sat/熵比/惊讶漂移），
//     禁止文学化（B 级后新尺度：surprise ~20 量级、σ 层级出现、sat 0.88→0.00）；
//     熵饱和区（entropy > 0.98）走探测型读数注入（读数 + 不可判标注，非异常判定）——R4 降级路径。
//   ③thought：1 条默认 + 余量灰度升 2（R7；C1 观测：INJECTED len 分布 + 回魂段截断率）。
//   ④焦点记忆六层衔接加权：相关性×trust×景观激活 取舍（R4，滤伪相关——Power of Noise）。
//     数据链路：插件直调 127.0.0.1:8190（同主机，零 glue 改动——任务书首选直调）。

import { appendFileSync, readFileSync } from "node:fs";

const GLUE_DEFAULT_URL = process.env.GLUE_URL || "http://127.0.0.1:19000";
// P1-1（阶段 2 步骤 2）：景观叙事直调 LMS /landscape/{sid}——插件与 LMS 同主机
// （127.0.0.1:8191），直调零 glue 改动（任务书授权：首选直调）；只读 fail-open。
// [2026-08-30 修复] V1 LMS :8190 已停用（四妹 V2 切换，agentos-v2/lms-api 监听 :8191）。
// 旧端口死等 LANDSCAPE_TIMEOUT_MS×N 会阻塞网关事件循环（实测 event_loop_delay 2s、
// models.list 4.7s、子代理启动 19.6s → UI 模型栏空、子AI「已停止」）。env 可覆盖。
const LMS_DEFAULT_URL = process.env.LMS_URL || "http://127.0.0.1:8191";
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
// [2026-09-09 dandan] 5→8：增加召回条数（对齐四妹 MEMORY_K，防上下文稀释）
const FOCUS_MAX_ITEMS = 8;
// 注入块 ≤800 字硬约束（lost-in-the-middle 2307.03172：短块内位置效应可控；
// 超出走 composeContext 截断保活——[回魂] 段永不先截，先截记忆块尾部）
// [2026-09-09 dandan] 800→12000：召回太短进上下文即被稀释，宁多勿短
// （四妹侧 MAX_TEXT 已 12000，两边对齐；上下文 1M token 余量充足）
const INJECT_MAX_CHARS = 12000;
// ── 阶段 2 思考链：thought notes 接线（2026-08-13，设计 v1.1 §三-3）──
// 读 thoughts.jsonl（思考链产物流）最近 N 条，按"与当前对话的激活度"
// （字符 bigram 覆盖度，关键词法；设计允许 "embed 相似度或关键词"——注入
// 热路径不加 embed 网络调用）取 1-2 条注入；激活度低于阈值则不注入
// （设计："当前对话激活了哪个 thought 注入哪个；未激活不注入"）。
const THOUGHTS_FILE =
  process.env.THOUGHTS_PATH || "/vol2/1000/AI专用/所有自动化/轻如烟/memory/thoughts.jsonl";
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

// ── 阶段 2 步骤 3（P1-2 检索时怀疑，2026-08-16，定稿 v2 §五）────────────
// score = relevance × (α·trust + β·consistency) × landscapeAct
//   （R4 景观激活乘数保留——审计 D 已实证步骤 2 加权；本步骤补 α/β 公式）
//   - α/β 起步 0.6/0.4（R5）+ 梯度扫描准备：env SCORE_ALPHA/SCORE_BETA
//     （0.5/0.5、0.7/0.3 扫描无需改码），参数先落盘（SCORE-PARAMS 日志）
//   - trust 语义（LMS 置信度场）：⚠️置信 标注（integration_service 只注
//     confidence<0.5 条目）→ 无标注默认 1.0（fail-open 不误杀）
//   - R1 曲解修正（二选一禁双重惩罚）：trust<SCORE_TRUST_THRESHOLD(0.3) →
//     降权 ×SCORE_DOWNGRADE_FACTOR(0.3) 或标 [doubt] lowconf（二选一；
//     默认降权，SCORE_DOUBT_MODE=annotate 可切换）
//   - R8 trust 归一化核验先行：TRUST-DIST 日志（批内分布 min/max/mean/
//     p10/p50/p90）观测尺度漂移（B 级后 π̄ 变化影响 trust 尺度？）；阈值
//     参数化（SCORE_TRUST_THRESHOLD）先落盘后进生产
//   - consistency：静态入库默认 0.5（中性；无在线一致性信号时）+ 仅低信任
//     窄路径在线多采样（SelfCheckGPT 工程同构：直调 LMS POST /recall 只读
//     端点的 recall-time consistency——compute_consistency 召回时计算、
//     count_reference=False 零持久化；按 text join）
const SCORE_ALPHA_DEFAULT = 0.6;
const SCORE_BETA_DEFAULT = 0.4;
const SCORE_TRUST_THRESHOLD_DEFAULT = 0.3;
const SCORE_DOUBT_MODE_DEFAULT = "downgrade"; // "downgrade" | "annotate"（R1 二选一）
const SCORE_DOWNGRADE_FACTOR = 0.3;           // 定稿 v2 §五-3：trust<0.3 → ×0.3 降权
const CONSISTENCY_STATIC_DEFAULT = 0.5;       // 静态入库默认（中性：无抽样印证信息）
const CONSISTENCY_FETCH_TIMEOUT_MS = 4000;    // 窄路径 /recall 快路径（同 /landscape）

// ── 阶段 2 步骤 4（P1-3 注入时验证链，2026-08-16，定稿 v2 §六）────────────
// 高 stakes 可操作化（R6）：stakes 判定 = ①注入内容与高信任记忆冲突 +
// ②话题敏感度（env 白名单 STAKE_TOPICS，逗号分隔关键词；默认空 =
// 全走冲突判定）。冲突检测用共享片段匹配（overlapMatch，_find_overlapping_entry
// 工程匹配的扩展——纯包含匹配会漏掉"前缀相同、取值相反"的真实冲突对，
// 任务书验收场景即此类）。[doubt] 前缀条目是系统事件（非对话，同 8/10
// 垃圾过滤哲学），不进候选也不作高信任参照（防回声防线 1）。
// 验证链（CoVe 轻量：草稿→独立验证→修正）与 provenance 防回声详见
// runVerifyChain 段注释（本处仅常量）。参数先落盘（VERIFY-PARAMS 日志）。
// P1 修复（审计 2026-08-16 三根因）：验证检索/写超时参数化（同 DIFFUSE_ENTROPY_RATIO
// 模式：env 可覆盖，默认 4000——测试无需等 4s 即可模拟写超时竞态）。
const VERIFY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.VERIFY_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
})();
const VERIFY_K_DEFAULT = 5;             // 验证批次 k（小批量，够判定可复现性）
const VERIFY_MAX_CHAINS = 2;            // 每轮验证链条数上限（预算纪律，防风暴）
const VERIFY_OVERLAP_MIN = 5;           // 共享片段最小长度（防 2-3 字高频词伪冲突）
const VERIFY_WRITE_DEDUP_MS = 60000;    // 写侧幂等窗口（同 /store 60s 去重哲学）
// P1-3 修复（根因 3）：幂等窗口内写尝试上限——半死服务（/feed 挂但 /recall 活）
// 时窗口滑动重试被封顶，防旧版 14 次重写式放大（每窗口 ≤2 次，且均先查重）。
const VERIFY_MAX_WRITE_ATTEMPTS = 2;
// P1-3 修复（根因 2）：数值矛盾判定阈值（0 = 共享上下文内数值集合任何差异即矛盾；
// 参数化预留——后续如发现日期抖动类误报可上调，无需改码）。
const VERIFY_NUM_DIFF_THRESHOLD = (() => {
  const raw = Number(process.env.VERIFY_NUM_DIFF_THRESHOLD ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
})();
// P1-3 修复（根因 2）：否定词极性翻转判定窗口 = 共享片段边界 ±3 字（只认紧贴片段
// 的否定，远处否定不算——防“双方存在”类伪矛盾，见 isContradictionPair 注释）。
const VERIFY_NEGATION_NEAR_CHARS = 3;
const HIGH_TRUST_MIN = 0.5;             // 高信任判定：无 ⚠️标注（默认 1.0）或标注 ≥0.5
const VERIFY_DOUBT_PREFIX_RE = /^\s*\[doubt(?:-[a-z]+)?\]/i; // 防回声：系统事件非验证候选。
// [doubt] conflict 事件 + [doubt-supersedes] 证伪标记（旧污染条目梦期改写产物）均排除——
// 2026-08-16 灰度开启时真实数据实证：supersedes 标记内含原文本 → 必然 overlap →
// 占 stake 6/35（17%）制造验证链噪音、污染 contradiction=false 灰度指标。

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

// ── 第五刀（2026-09-21）：召回**输入面**机器段剥离 ────────────────────────
// 现场（2026-09-21 16:14 一次真实醒来）：焦点记忆 5 条全是 8 月"自主醒来没反应"
// 长文（各数百字），与本次醒因（"惊讶突变 z=2.3"）话题像、时效废。根驱动——
// **召回 query = 醒因原文**：`🌙【梦中醒来】自主醒来（…）：惊讶度… / 熵… |
// 当前记忆处于… | 激活节点:…⏎→ 我想:…` ⇒ "自主醒来/唤醒"这类**系统词**被当成
// 检索主题，每次醒来都钓回同一批 8 月长文（上一单四刀治的是**消费端**排序/去重，
// 治不了输入面这个根驱动）。
// 药：文本进 extractQueryText 前先剥**机器生成部分**，只留人类可读线索；
// **剥净（纯机器载荷）→ 无人类线索 → 不注入**（与心跳/子代理同路径）。
// 词表单一来源：与 `lms-core/message_markers.py` 的 PREFIX_MARKERS /
// PRODUCER_PAYLOADS / SOURCE_LABEL_PREFIXES 语义对齐（跨语言不 import，此处登记
// 同一批字面量；新增标记先在该 py 与此处同步，防字面漂移）。
const QUERY_MACHINE_LINE_PREFIXES = [
  // 唤醒通知横幅（message_markers: PREFIX_MARKERS 的三条生产者横幅）
  "🌙【梦中醒来】", "📬【信箱新消息】", "【信箱·新留言】",
  // 注入段横幅（同 PREFIX_MARKERS / SOURCE_LABEL_PREFIXES 的 [回魂] 族）
  "[回魂]", "[行动]", "[信息性标注", "[记忆注入]", "[记忆系统自述]",
  "[wake-bridge]", "[lms-memory]", "[心跳]", "[系统]", "[cron:",
  "[Subagent Context]", "[Inter-session message]",
];
// self_pulse 载荷续行（PRODUCER_PAYLOADS 同款模板：`\n→ 我想:`）——机器自己拼的
// 悬案续写，**内含它引用的旧用户原话**（正是"看着像人话、其实是机器拼的"污染源）。
const QUERY_MACHINE_LINE_RE = /^(?:→|->)\s*我想[:：]/;
// 运行时模板 token（`<|im_start|>` / `<|im_end|>` / `<|endoftext|>` 等）——非人话。
const TEMPLATE_TOKEN_RE = /<\|[\w-]{1,40}\|>/g;
// 机器自述段（右脑【重理解】= 机器对用户话的二次解析，**非用户原话**）：整段剔除。
// 单一来源：message_markers.py 的 PRODUCER_PAYLOADS/SOURCE_LABEL_PREFIXES 同族。
const MACHINE_SEGMENT_RES = [
  /【重理解】[^\n]*/g,
  // 重理解续行（右脑第一人称转述）：要求机器形状的标点（实测三型“我听到的是“…”/“，”/“：”）
  /我听到的是\s*[:：，,“][^\n]*/g,
];
// 行内机器读数段（系统词）：只在"惊讶度/熵 + 数字"这种机器形状上生效——
// 人话"为什么惊讶度这么高？"（无数字）不受影响（宁缺毋滥）。
const MACHINE_INLINE_READING_RES = [
  /惊讶度\s*[\d.]+[^｜|\n]*/g,
  /熵\s*[\d.]+[^｜|\n]*/g,
  /激活节点[:：][^\n]*/g,
  /当前记忆处于[^｜|\n]*/g,
  /当前关注方向[^｜|\n]*/g,
  /多个记忆模式同时激活/g,
  /发生于\s*\d+\s*分钟前/g,
];

/** 机器横幅行判定（纯函数）：行首是唤醒/注入横幅或 self_pulse 续行 → true。
 * 按**行首前缀**判（人在句中“提到”这些标记不受影响，宁缺毋滥）。
 */
function isMachineQueryLine(line) {
  const t = String(line).trim();
  if (!t) return false;
  if (QUERY_MACHINE_LINE_RE.test(t)) return true;
  return QUERY_MACHINE_LINE_PREFIXES.some((p) => t.startsWith(p));
}

/** 剥掉 marker 后的**配平括号段**（含嵌套；括号不平衡=截断 → 吃到行尾）。
 * 用于 "自主醒来（…（…）…）" 这类带嵌套括号的机器令牌；找不到 marker 原样返回。
 */
function stripBalancedAfter(text, marker) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf(marker, i);
    if (idx === -1) { out += text.slice(i); break; }
    out += text.slice(i, idx);
    let j = idx + marker.length;
    let depth = 1; // marker 末尾已含一个左括号
    while (j < text.length && depth > 0) {
      const ch = text[j];
      if (ch === "（" || ch === "(") depth += 1;
      else if (ch === "）" || ch === ")") depth -= 1;
      j += 1;
    }
    if (depth > 0) { // 不平衡（被截断）→ 吃到行尾，避免残留半截
      const nl = text.indexOf("\n", j);
      j = nl === -1 ? text.length : nl;
    }
    i = j;
  }
  return out;
}

/** 召回输入面机器段剥离（纯函数，第五刀）。剥四类：
 *   ① 模板 token（`<|im_start|>` 等）
 *   ② 机器自述段（【重理解】/我听到的是 到行尾）
 *   ③ 机器**横幅整行**（唤醒通知/注入段横幅/`→ 我想:` 续行）
 *   ④ 行内机器读数段（惊讶度/熵/激活节点/自主醒来（…）…）
 * 返回**人类可读线索**（空白归一 + trim）；剥净 → 返回 ""（调用方据此不注入）。
 * fail-open：非字符串/异常 → 原样返回（绝不阻断注入）。
 */
export function stripMachineQuerySegments(text) {
  if (typeof text !== "string" || !text) return text;
  try {
    let out = text.replace(TEMPLATE_TOKEN_RE, " ");
    for (const re of MACHINE_SEGMENT_RES) out = out.replace(re, " ");
    out = out
      .split(/\r?\n/)
      .filter((line) => !isMachineQueryLine(line))
      .join("\n");
    out = stripBalancedAfter(out, "自主醒来（");
    out = stripBalancedAfter(out, "自主醒来(");
    for (const re of MACHINE_INLINE_READING_RES) out = out.replace(re, " ");
    return out.replace(/[｜|]+/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return text; // fail-open：清洗失败退旧行为（原文进召回）
  }
}

/**
 * 从完整 prompt 提取用户真实正文作为检索 query（召回L1-a）。
 * 先 stripInboundMetadata（元数据/时间戳），再剥 [Subagent Context]/[Subagent
 * Task]/[Inter-session message] 模板前缀；剥离后为空 / 心跳 poll / 子代理
 * 指令正文 / 跨会话仅剩来源参数 → 返回 null（不注入）。
 * 第五刀（2026-09-21）：再剥机器段（stripMachineQuerySegments）——唤醒轮不再用
 * 醒因原文（系统词）当检索主题；**剥净 → null 不注入**。开关 hygiene.stripMachineQuery
 * （默认开；hygiene 缺省 null = 旧行为零变化，向后兼容）。
 * 失败（异常）→ 回落原逻辑 prompt.trim().slice(0, QUERY_MAX_CHARS)（fail-open）。
 */
export function extractQueryText(prompt, hygiene = null) {
  return extractQueryInfo(prompt, hygiene).query;
}

/**
 * 第六刀（2026-09-21，dandan 17:50 亲批「剥机器段对，但别把回魂一起剥掉」）：
 * `extractQueryText` 的**带因版**——同样剥机器段，但额外交回「为什么是 null」。
 *
 * 这条区分专治第五刀的**副作用**：第五刀之后，唤醒轮（醒因原文=纯机器载荷）的
 * query 被剥净 ⇒ 走 `empty-query → return null` ⇒ **连【回魂】也一并不注入了**
 * （我每次醒来看不到自己是谁/最近在干什么 = 拆了失忆防护）。本函数把两类 null 分开：
 *
 *   | 情形 | query | machineOnly | 调用方动作 |
 *   |---|---|---|---|
 *   | 纯元数据 / 心跳 poll / 子代理模板 / 跨会话仅剩参数 | null | **false** | 照旧不注入（非人类轮） |
 *   | 剥机器段后为空（醒因原文=纯机器载荷） | null | **true** | 可走「只注回魂」路径 |
 *   | 有人类可读线索 | 非空 | false | 照常注入（回魂 + 记忆块） |
 *
 * 判据（机器轮）＝**第五刀剥净**：`stripMachineQuerySegments(text) === ""`。
 * 剥除表只含机器生成部分（横幅整行/机器读数/【重理解】/模板 token），故「剥净」
 * 等价于「原文里没有一处人类可读线索」——不是靠猜，是剥除表的必然推论。
 * 注意：不是「含机器词的轮」都算机器轮——人话引用唤醒横幅时剥完仍有残留
 * （实测生产 219 次里唯一那条），此时 machineOnly=false，走正常注入（宁缺毋滥）。
 *
 * @returns {{query: string|null, machineOnly: boolean}} query 同 extractQueryText 语义
 *   （非字符串 prompt → ""）。fail-open：异常 → {query: prompt.trim().slice(0,200), machineOnly:false}。
 */
export function extractQueryInfo(prompt, hygiene = null) {
  if (typeof prompt !== "string") return { query: "", machineOnly: false };
  try {
    let text = stripInboundMetadata(prompt);
    text = text.replace(TEMPLATE_PREFIX_RE, "").trim();
    if (!text) return { query: null, machineOnly: false }; // 纯元数据/纯模板 → 不注入
    if (HEARTBEAT_POLL_RE.test(text)) return { query: null, machineOnly: false };
    if (SUBAGENT_BODY_RE.test(text)) return { query: null, machineOnly: false };
    if (CN_ISOLATED_AGENT_RE.test(text)) return { query: null, machineOnly: false }; // P1-3：中文隔离子代理模板
    if (INTERSESSION_META_ONLY_RE.test(text)) return { query: null, machineOnly: false };
    // 第五刀：剥机器段（hygiene 缺省/开关关 → 不剥，保持旧行为）
    if (hygiene && hygiene.stripMachineQuery !== false) {
      text = stripMachineQuerySegments(text);
      if (!text) return { query: null, machineOnly: true }; // 纯机器载荷（醒因原文）剥净 → 无人类线索
    }
    return { query: text.slice(0, QUERY_MAX_CHARS), machineOnly: false };
  } catch {
    // fail-open：净化失败回落原逻辑（不崩、不阻断）
    return { query: prompt.trim().slice(0, QUERY_MAX_CHARS), machineOnly: false };
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

// 第六刀（2026-09-21）：唤醒轮「只注回魂」计数（与 INJECTED 区分——它不含记忆块，
// 不可混入 C1 的 INJECTED len 分布；也便于事后从日志区分“唤醒轮到底注了没”）。
function logSoulOnlyWake(len) {
  try {
    appendFileSync(DEBUG_LOG_FILE, `[${new Date().toISOString()}] INJECTED-soul-only len=${len}\n`);
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
    k: Number.isFinite(cfg.k) ? Math.max(1, Math.min(20, Math.floor(cfg.k))) : 8,
    minIntervalMs: Number.isFinite(cfg.minIntervalMs)
      ? Math.max(0, Math.floor(cfg.minIntervalMs))
      : 2000,
    maxChars: Number.isFinite(cfg.maxChars)
      ? Math.max(200, Math.min(20000, Math.floor(cfg.maxChars)))
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
    // P1-2（阶段 2 步骤 3）：lmsRecallConsistencyEnabled——低信任窄路径
    // 在线多采样（SelfCheckGPT 工程同构）开关，默认开；关闭则 consistency
    // 全走静态默认（fail-open 兼容路径）。
    lmsRecallConsistencyEnabled: cfg.lmsRecallConsistencyEnabled !== false,
    // P1-3（阶段 2 步骤 4）：verifyChainEnabled——注入时验证链开关。
    // 灰度开启（2026-08-16，P1 三根因修复重审正式通过后，dandan 拍板）：
    // 默认开（cfg.verifyChainEnabled !== false）；快速回滚 = 插件配置一行
    // verifyChainEnabled:false（a8fe757 曾默认关止血，此处恢复完整功能）。
    verifyChainEnabled: cfg.verifyChainEnabled !== false,
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
// 阶段 2 P1-2（2026-08-16）：score 公式/参数/R1 二选一/R8 核验纯函数均随函数
// 声明 export（resolveScoreParams/normalizeEntryKey/trustDistributionStats/
// computeFocusScore/applyLowTrustPolicy/fetchLmsRecallConsistency）。
// 阶段 2 P1-3（2026-08-16）：overlapMatch/detectHighStakes/fetchLmsVerify/
// runVerifyChain 均随函数声明 export（纯函数 + 无副作用 HTTP 封装）。
// P1 修复（审计 2026-08-16 三根因）：stripVerifyMetadata/isContradictionPair/
// verifyIngested/writeDoubtConflict 亦随函数声明 export（供单测直测根因语义）。
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

/**
 * 直调 LMS POST /recall 取召回簇 consistency（阶段 2 P1-2 低信任窄路径
 * 在线多采样，2026-08-16，定稿 v2 §五-4）。
 *
 * 只读语义（api/server.py /recall → recall_merged_readonly →
 * recall_episodic_readonly(count_reference=False)）：不 process_turn、不调
 * LLM、不写缓冲、不落盘、不计数引用——零持久化；内部 _attach_consistency
 * 只更新进程内观测（Koriat 自一致性 = SelfCheckGPT 工程同构，recall-time
 * 计算）与置信度窗口（记录侧，非状态场——doubt_baseline 只由 process_turn
 * 的 observe_surprise 更新，本路径不触碰）。
 *
 * 返回 {normalizedText: {consistency, adaptiveConfidence, doubtVerdict}}；
 * 无一致性字段 / 异常 / 超时 → null（fail-open）。仅 buildMemoryContext
 * 在检测到低信任条目（trust < SCORE_TRUST_THRESHOLD）时调用——窄路径。
 */
export async function fetchLmsRecallConsistency(cfg, query) {
  const url = `${cfg.lmsUrl}/recall`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONSISTENCY_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: String(query || "").slice(0, QUERY_MAX_CHARS),
        k: Math.max(1, Math.min(20, Math.floor(cfg.k || 8))),
        session_id: cfg.landscapeSid || LANDSCAPE_SID,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logMiss(`consistency-non-2xx status=${resp.status} url=${url}`);
      return null;
    }
    const data = await resp.json();
    const results = Array.isArray(data && data.results) ? data.results : [];
    const map = {};
    for (const r of results) {
      const t = String((r && r.text) || "").trim();
      if (!t || typeof r.consistency !== "number") continue;
      map[normalizeEntryKey(t)] = {
        consistency: r.consistency,
        adaptiveConfidence: typeof r.adaptive_confidence === "number"
          ? r.adaptive_confidence : null,
        doubtVerdict: r.doubt_verdict === true,
      };
    }
    return Object.keys(map).length > 0 ? map : null;
  } catch (err) {
    const why = err && err.name === "AbortError" ? "timeout" : "network-error";
    logMiss(`consistency-${why} url=${url} timeoutMs=${CONSISTENCY_FETCH_TIMEOUT_MS}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 阶段 1 熵饱和区专项（2026-08-16，v1.2 §四；2026-09-18 判据更正）：探测型注入 ──
// 熵饱和区下“激活主题叙事”是零信息套话（3.08 教训：叙事型适配会鼓励
// “弥散态是结晶前的东西”类空话）。改报可验证读数 + 显式状态标注：
//   报数，不编故事；信息量为零的文学化描述禁止进注入面。
// 判据 3.09（v1.2 版；2026-09-18 更正）：“输出可验证的状态读数（具体数字/
// 漂移量）+ 显式状态标注”——标注语义 = 存量判据失效·不可判，不是 [异常]：
//   熵在双极饱和区近似常数（健康、在分化的场 entropy_norm≈0.9997），“熵高⇒异常”
//   必然误报（四妹 2026-09-18 量化：判别力 68.7% vs 0% 时熵 0.9997 vs 1.0，
//   判别力=0 时熵反而更低）⇒ 本条只做信息性标注，不下异常结论。
// 时序与定位（v1.2 §四）：本适配是行为层过渡补丁，不等同于状态场修复；
// 若 A 级修复成功（entropy_norm 回落 0.5–0.9），本分支自然不触发，
// 注入面恢复“激活主题叙事”。阈值 DIFFUSE_ENTROPY_RATIO（默认 0.95，
// 对齐系统 entropy_high_threshold=0.9 之上沿，防抖动）。
const DIFFUSE_ENTROPY_RATIO = (() => {
  const raw = Number(process.env.DIFFUSE_ENTROPY_RATIO ?? "");
  // 定稿 v2 §四-3 / 任务书：entropy > 0.98 走探测型读数注入（R4 降级）。
  // 2026-09-18：本分支保留为“读数上报”，不再自任“异常判定”（饱和区熵不可判别）。
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.98;
})();

/**
 * 探测型注入（阶段 1 熵饱和区专项，v1.2 §四定稿；阶段 2 P1-1 增 /landscape 读数）
 * ——报数，不编故事。
 *
 * 熵饱和区输出可验证的状态读数 + 显式状态标注（判据 3.09 v1.2 版，2026-09-18 更正：
 * “输出可验证的状态读数（具体数字/漂移量）+ 显式状态标注”；标注 = 不可判，非 [异常]）。
 *
 * 样例（v1.2 §四；2026-09-18 更正后）：
 *   状态：不可判·熵饱和区（熵 0.9998 / 激活 256/256 / max|σ_act| 0.999）
 *   漂移读数：entropy Δ=+0.0002 / 惊讶 9.96
 *   缺口：fok=0 / low_confidence=0
 *   [诊断标注（非读数）：惊讶度 mse 线性、方向无响应——供诊断/决策消费，
 *    不入“报数”行]
 *
 * 阶段 2 P1-1：landscapeData 在场时，状态行并入 /landscape 激活拓扑读数
 * （激活 A/N·max|σ_act|）——弥散态下 σ 扁平本身就是特征读数（B 级后尺度：
 * sat 0.88→0.00、max|σ_act| 回落），报数不编故事。
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

  // 读数行 1：状态读数（显式状态标注：饱和区不可判，非 [异常]）
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
      // [2026-09-18 同名不同义踩坑记录] 本读数 = activation.top_activated 的 max|σ|
      // = **最强节点激活幅值**（无量纲，[0,1]）——**不是** energy.sigma_max
      // （J 谱半径，随 ‖J‖_F 缩放，实测 7~12），**也不是** σmax/‖J‖_F 比值。
      // 旧文案裸写 `σmax0.93`，与守护/报告里的 σmax（J 谱半径）同名 ⇒ 同一响应
      // 两处 σmax 差 8.4 倍、读者（人和模型）误当同一量（四妹 09-18 文书）。
      // 故渲染名改为 max|σ_act|（定义随名自带，杜绝与 σmax(J) 撞名）。
      if (sigmaMax > 1e-9) bits.push(`max|σ_act|${sigmaMax.toFixed(2)}`);
    }
  }
  if (surprise !== null) bits.push(`惊讶${surprise.toFixed(2)}`);
  if (mse !== null) bits.push(`mse${mse.toFixed(3)}`);
  if (precisionMean !== null) bits.push(`π̄${precisionMean.toFixed(3)}`);
  const stateLine = `状态：不可判·熵饱和区（存量判据失效；见 09-18 量化）（${bits.join(" / ")}）`;

  // 读数行 2：漂移读数（可验证数字；缺字段不编）
  const driftBits = [];
  // P2-4（审计 2026-08-16）：原条件 `typeof s.entropy_ratio === "number" &&
  // typeof s.entropy_ratio === "number"` 是同义反复（同一表达式两次）；且漂移行
  // "熵比"取 react 源、与弥散闸门的 /landscape entropy_norm 同标签不同源——
  // 观测时易误读为同一值。修正：双源判断 + 标签区分来源（react/soul）。
  if (typeof r.entropy_ratio === "number") {
    driftBits.push(`熵比(react)${r.entropy_ratio.toFixed(4)}`);
  } else if (typeof s.entropy_ratio === "number") {
    driftBits.push(`熵比(soul)${s.entropy_ratio.toFixed(4)}`);
  }
  if (surprise !== null) driftBits.push(`惊讶${surprise.toFixed(2)}`);
  const driftLine = driftBits.length
    ? `漂移读数：${driftBits.join(" / ")}`
    : null;

  // 缺口行：当前无 /soul 字段 → 显式“不可读”（不编数字）
  const gapLine = "缺口：fok/low_confidence 不可读（无 /soul 缺口字段）";

  // 诊断标注（非读数，供诊断/决策消费）：
  // P2-7（审计 2026-08-16）：明确来源——本行是存量判据文本，非本轮读数派生
  // （诚实标注不变，来源显式化）；完整派生诊断属后续步骤。
  // 2026-09-18 判据更正：熵高不再作为异常判据（饱和区熵近似常数、判别力≈0，
  // 健康、在分化的场也恒踩阈值 ⇒ 必然误报）。可判的替代判据须为尺度不变/
  // 行为量（lam1_edge 变化 / lam2/lam1 / σ 符号一致率）——本注入源
  // （/landscape activation、/react）当前无这些字段，故饱和区一律返回“不可判”，
  // 只保留读数做信息性标注。
  const diagLine =
    "[信息性标注：熵高≠异常；替代量 lam1_edge/lam2·lam1/σ符号一致率 注入源暂无⇒不可判]";

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
 *   - 主导盆地数：top_activated 中 |σ| ≥ 0.5 的个数（B 级后新尺度 max|σ_act|≈0.79、
 *     σ 层级出现：p10 0.575/p50 0.652/p90 0.727；0.5 以上=显著激活盆地）
 *   - 激活拓扑：active_nodes/num_nodes（如 253/256）
 *   - σ 层级：max|σ_act| + 峰差 Δ（top1−top2）+ sat 派生（max|σ_act|<0.9 ⇒ sat=0.00，
 *     B 级后 sat 0.88→0.00 的读数依据——top_activated 含全局最大 |σ|）
 *     注：此处的 σ 是**激活幅值**（无量纲），不是 energy.sigma_max（J 谱半径）；
 *     09-18 前两者都渲染成裸 `σmax` ⇒ 同名不同义（见 buildDiffuseProbe 注释）
 *   - 漂移读数：惊讶（/react reaction.surprise 或 /soul last_surprise，
 *     B 级后 ~20 量级）+ surprise_z 方向（>1 上升 / <-1 回落 / 平稳）
 *
 * 熵饱和区降级路径（R4/定稿 v2 §四-3）：entropy > 0.98（DIFFUSE_ENTROPY_RATIO）
 * → 探测型读数注入（buildDiffuseProbe：报数 + 不可判标注，非异常判定），不输出激活主题叙事。
 * 2026-09-18 更正：本分支只上报读数，不再把“熵高”当异常（饱和区熵不可判别）。
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

  // 熵比：/landscape entropy_norm 优先（熵饱和区读数闸门），react/soul 兜底
  const entropyRatio = typeof landAct?.entropy_norm === "number"
    ? landAct.entropy_norm
    : (typeof react.entropy_ratio === "number"
        ? react.entropy_ratio
        : (typeof st.entropy_ratio === "number" ? st.entropy_ratio : null));

  // 熵饱和区降级路径（R4）：entropy > 0.98 → 探测型读数注入（读数 + 不可判标注）
  if (entropyRatio !== null && entropyRatio >= DIFFUSE_ENTROPY_RATIO) {
    const probe = buildDiffuseProbe(react, st, entropyRatio, landscapeData);
    if (probe) {
      // ≤200 字硬约束同样适用于探测段（定稿 v2 §四-2：景观叙事 ≤200）；
      // slice(0, 200-1)+"…" 保证截断后恰好 ≤200（旧实现 200+"…"=201 破界）
      if (probe.length > LANDSCAPE_MAX_CHARS) {
        return `${probe.slice(0, LANDSCAPE_MAX_CHARS - 1)}…`;
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
      // σ 层级：max|σ_act| + 峰差 Δ（top1−top2）+ sat 派生
      // [2026-09-18 同名不同义] 渲染名由裸 `σmax` 改为 `max|σ_act|`——此值是
      // 激活幅值（无量纲），非 J 谱半径 σmax（7~12）、非 σmax/‖J‖_F 比值。
      const sigmaMax = Math.max(...top);
      const sigma2 = top.length > 1 ? Math.max(...top.slice(1)) : 0;
      const peakGap = sigmaMax - sigma2;
      const sat = sigmaMax < 0.9 ? "0.00" : ">0"; // max|σ_act|<0.9 ⇒ 无饱和（B 级后）
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
          `max|σ_act|${sigmaMax.toFixed(2)}·Δ${peakGap.toFixed(2)}·sat${sat}`,
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
  // ≤200 字硬约束（定稿 v2 §四-2）；slice(0, 200-1)+"…" 保证截断后 ≤200
  if (out.length > LANDSCAPE_MAX_CHARS) out = `${out.slice(0, LANDSCAPE_MAX_CHARS - 1)}…`;
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
// P2-1（审计 2026-08-16）：SOUL-TRUNC 日志——C1 判据"回魂段截断率 ≥100 轮
// 稳定"的直接数据源（此前仅 THOUGHT-FALLBACK 可作代理）。buildSoulText 最终
// slice 处发射（回魂段实际被截断才记）。
function logSoulTrunc(fromLen, maxChars) {
  try {
    appendFileSync(
      DEBUG_LOG_FILE,
      `[${new Date().toISOString()}] SOUL-TRUNC from=${fromLen} max=${maxChars}\n`,
    );
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

/** 组装 thought 注入行（≤THOUGHT_MAX_CHARS/条，1-2 条；无命中 → null）。
 * P2-3（审计 2026-08-16）：返回 {line, count}——条数以 pickThoughts 实际选中数
 * 计，替代旧 `includes("｜") ? 2 : 1` 启发式（单条 thought 文本含"｜"会误计；
 * 降级轮无 INJECT n=1 记录 → 观测连续性缺口）。 */
export function buildThoughtLayer(query, thoughts, cfg, maxItems = THOUGHT_INJECT_MAX) {
  const picked = pickThoughts(query, thoughts, cfg, maxItems);
  if (picked.length === 0) return null;
  const bits = picked.map(({ thought }) => {
    let text = String(thought.text || "").trim().replace(/\s+/g, " ");
    if (text.length > THOUGHT_MAX_CHARS) text = `${text.slice(0, THOUGHT_MAX_CHARS)}…`;
    const topic = thought.topic ? `【${thought.topic}】` : "";
    return `${topic}${text}`;
  });
  return { line: `thought:${bits.join("｜")}`, count: picked.length };
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
export function buildSoulText(data, maxChars = SOUL_MAX_CHARS, reactData = null, query = "", cfg = null, pickedThoughts = null, landscapeData = null, hygiene = null) {
  // data 为 null = 未启用/请求失败（原因已在 postJson 记 MISS），此处不重复记
  if (!data || typeof data !== "object") return null;
  const parts = [];

  // 1. 自述（LMS self_ref）：去重 + 最多 2 条（蒸馏缓存会产出连续重复）
  const voices = Array.isArray(data.lms_voice)
    ? data.lms_voice.filter((v) => typeof v === "string" && v.trim())
    : [];
  // cut a+b（2026-09-21）：自述本是机器语音，其中"激活节点"清单类（现场 4 条
  // 仅编号不同）应剔/折叠——与 buildContextText 的 self_ref 同法（词表同源）。
  let voicesClean = voices;
  if (hygiene && typeof hygiene === "object") {
    try {
      if (hygiene.stripMachineNarration) voicesClean = voicesClean.filter((v) => !isMachineNarration(v));
      if (hygiene.dedupeNearDuplicates) {
        const seen = new Set();
        voicesClean = voicesClean.filter((v) => {
          const fp = narrationFingerprint(v);
          if (seen.has(fp)) return false;
          seen.add(fp);
          return true;
        });
      }
    } catch { /* fail-open：退旧行为 */ }
  }
  const uniqVoices = [...new Set(voicesClean.map((v) => v.trim().replace(/\s+/g, " ")))].slice(0, 2);
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
  if (landscape) {
    // cut a：剃掉景观叙事里的 [信息性标注：…] 机器标注段（读数保留）。
    const cleaned = hygiene && typeof hygiene === "object" && hygiene.stripMachineNarration
      ? scrubMachineSegments(landscape) : landscape;
    if (cleaned) parts.push(cleaned);
  }

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
    const thoughtLayer = buildThoughtLayer(query, thoughts, cfgT, THOUGHT_INJECT_MAX);
    if (thoughtLayer && thoughtLayer.line) {
      parts.push(thoughtLayer.line);
      const provisional = `[回魂] ${parts.join(" / ")}`;
      if (provisional.length > maxChars) {
        // R7 灰度降级：2 条超预算 → 1 条（回魂段永不先截，丢 thought 不丢状态）
        parts.pop();
        const oneLayer = buildThoughtLayer(query, thoughts, cfgT, 1);
        if (oneLayer && oneLayer.line) parts.push(oneLayer.line);
        logThoughtFallback(2, 1);
        logThoughtInject(1); // P2-3：降级轮仍记录实际注入条数（观测连续性）
      } else {
        logThoughtInject(thoughtLayer.count); // P2-3：实际条数（非"｜"启发式）
      }
    }
  }

  // 4. 最近（沙漏最新记忆）：去重 + 最多 2 条（放 thought 之后=截断时先丢）
  //    第五刀（2026-09-21）：机器制品不进注入——现场"最近:"段出现
  //    `【重理解】2026-09-21 16:03:01 [dandan] 原话: …`（机器对用户话的重理解，
  //    虽带来源标签、不冒充用户，但属机器制品）。词表同源（isMachineNarration）。
  const recents = Array.isArray(data.recent)
    ? data.recent.filter((r) => r && typeof r.text === "string" && r.text.trim())
    : [];
  const uniqRecents = [];
  const seenR = new Set();
  for (const r of recents) {
    if (hygiene && typeof hygiene === "object" && hygiene.stripMachineNarration
        && isMachineNarration(r.text)) continue; // 机器制品（【重理解】等）跳过
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
  if (out.length > maxChars) {
    // P2-1（审计 2026-08-16）：SOUL-TRUNC 日志——C1 判据"回魂段截断率 ≥100 轮
    // 稳定"的直接数据源（此前仅 THOUGHT-FALLBACK 代理）
    logSoulTrunc(out.length, maxChars);
    out = `${out.slice(0, maxChars)}…`;
  }
  return out;
}

/**
 * 第六刀（2026-09-21，dandan 17:50 亲批）：唤醒轮「只注回魂」文本构造。
 *
 * 背景（第五刀的副作用）：唤醒轮醒因原文 = 纯机器载荷 ⇒ query 剥净为 null ⇒
 * 主路径 `empty-query` 直接 return null ⇒ **连【回魂】都不注** ⇒ 我每次醒来
 * 看不到自己是谁/最近在干什么。本函数把「剥召回输入」与「注回魂」解耦：
 * **不拿机器词去召回**（不调 /recall，零 z 窗口扰动）+ **仍注回魂**。
 *
 * 注入内容定义（写死在这里，别凭感觉）：
 *   ✅ 保留 = 【回魂】段的人可读部分：
 *      ① 自述（lms_voice 里的人话；机器语音按同源词表已剔）
 *      ② 状态：熵/惊讶/目的/轮次（buildSoulText 第 2 段）
 *      ③ 景观：读数派生一行（含熵饱和区的「缺口」行 + max|σ_act| 等读数；
 *         行内 [信息性标注…] 机器标注剔除）
 *      ④ 最近：沙漏最近记忆的**人类文本**（机器制品【重理解】等已剔）
 *   ❌ 不注 = 机器噪音：模板 token /【重理解】/ [记忆系统自述] / 激活节点: 清单 /
 *      [行动] / [生成约束] / [信息性标注…] / NO_REPLY；以及**记忆块**
 *      （[记忆注入] 焦点条目——那正是第五刀要去掉的陈旧长文）。
 *   ❌ 不注 thought 层：它按「与当前对话的激活度」选，唤醒轮无人类对话可对照（宁缺毋滥）。
 *
 * 只读保证：仅 /soul（快照）+ /landscape（GET 读数）两个只读端点；
 * **不调 /recall**（其会把本刻 surprise 追加进 z 判据窗口 = 生产扰动，见第五刀回执 §三）、
 * 不调 /react、不碰 /store //feed。任一失败 fail-open → null（不注入，绝不降级成机器噪音）。
 *
 * @returns {Promise<string|null>} 清洗后的 [回魂] 段；无内容/异常 → null
 */
export async function buildSoulOnlyWakeText(cfg, hygiene) {
  try {
    if (!cfg || typeof cfg !== "object" || cfg.soulEnabled === false) return null;
    const [soulData, landscapeData] = await Promise.all([
      fetchSoul(cfg),
      cfg.landscapeEnabled ? fetchLandscape(cfg) : Promise.resolve(null),
    ]);
    // query="" → 状态/景观/最近层照常，thought 层自然不选（无人类对话可激活）
    const soulText = buildSoulText(soulData, cfg.soulMaxChars, null, "", cfg, [], landscapeData, hygiene);
    if (!soulText) return null;
    // stripMachineNarration 已由 buildSoulText 内层生效（自述/最近/景观）；
    // 此处再做一遍整段兜底清洗（防 [信息性标注]/激活节点: 残留）。开关关 → 不洗。
    const cleaned = hygiene && hygiene.stripMachineNarration === false
      ? soulText
      : stripMachineNoiseFromSoul(soulText);
    if (!cleaned) return null;
    logSoulOnlyWake(cleaned.length);
    return cleaned;
  } catch (err) {
    logMiss(`soul-only-wake-fail ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── 阶段 2 步骤 3（P1-2 检索时怀疑）：score 公式 + R1 二选一 + R8 核验 ──
// 全部纯函数（零副作用），供 test-plugin.mjs 直接单测；热路径只读 process.env。

/**
 * 解析 P1-2 score 参数（R5 参数先落盘；env 驱动，默认 0.6/0.4 起步）。
 * 梯度扫描准备：SCORE_ALPHA/SCORE_BETA 可切 0.5/0.5、0.7/0.3 无需改码。
 * 无效值回退默认（fail-open）；doubtMode 只认 "annotate"（其余一律 downgrade）。
 */
export function resolveScoreParams(env) {
  const e = env && typeof env === "object" ? env : {};
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
  };
  const alpha = num(e.SCORE_ALPHA, SCORE_ALPHA_DEFAULT);
  const beta = num(e.SCORE_BETA, SCORE_BETA_DEFAULT);
  const trustThreshold = num(e.SCORE_TRUST_THRESHOLD, SCORE_TRUST_THRESHOLD_DEFAULT);
  const modeRaw = String(e.SCORE_DOUBT_MODE || SCORE_DOUBT_MODE_DEFAULT).toLowerCase();
  return {
    scoreAlpha: alpha,
    scoreBeta: beta,
    trustThreshold,
    doubtMode: modeRaw === "annotate" ? "annotate" : "downgrade",
  };
}

/** 条目文本归一化键：剥离尾部 ⚠️置信 标注（integration_service 只注 conf<0.5
 * 条目，glue 侧文本带标注、LMS 直调侧不带 → join 前必须归一）。 */
export function normalizeEntryKey(text) {
  return String(text || "")
    .trim()
    .replace(/\s*⚠️置信[\d.]+(?:驳\d+)?$/, "")
    .replace(/\s+/g, " ");
}

/**
 * score 公式（定稿 v2 §五-1）：score = relevance × (α·trust + β·consistency)。
 * R4（§四-3）景观激活乘数保留：调用方自行乘 landscapeAct（见 buildContextText）。
 * 数值防御：非有限/越界值回退中性（fail-open 不误杀）。
 */
export function computeFocusScore(relevance, trust, consistency, alpha, beta) {
  const a = Number.isFinite(alpha) ? alpha : SCORE_ALPHA_DEFAULT;
  const b = Number.isFinite(beta) ? beta : SCORE_BETA_DEFAULT;
  const t = Number.isFinite(trust) ? Math.max(0, Math.min(1, trust)) : 1.0;
  const c = Number.isFinite(consistency)
    ? Math.max(0, Math.min(1, consistency)) : CONSISTENCY_STATIC_DEFAULT;
  const rel = Number.isFinite(relevance) ? Math.max(0, relevance) : 1.0;
  return rel * (a * t + b * c);
}

/**
 * R1 曲解修正（定稿 v2 §五-3）：trust < 阈值 → 降权 ×0.3 或 [doubt] lowconf
 * 标注，**二选一禁双重惩罚**（构造上互斥：降权模式不标注、标注模式不降权）。
 * trust 无标注（parseConfidenceTag ?? 1.0）时恒 ≥1 > 阈值 → 本函数天然不触发。
 * 返回 {score, annotated}。
 */
export function applyLowTrustPolicy(score, trust, params) {
  const thr = Number.isFinite(params && params.trustThreshold)
    ? params.trustThreshold : SCORE_TRUST_THRESHOLD_DEFAULT;
  if (!(trust < thr)) return { score, annotated: false };
  if (params && params.doubtMode === "annotate") {
    return { score, annotated: true }; // 标注不降权
  }
  return { score: score * SCORE_DOWNGRADE_FACTOR, annotated: false }; // 降权不标注
}

/**
 * R8 trust 归一化核验先行：批内 trust 分布统计（纯函数）。
 * 返回 {count, min, max, mean, p10, p50, p90} 或 null（无有效值）。
 * 用途：TRUST-DIST 日志数据源——定阈值 0.3 前先核验分布是否尺度漂移
 * （B 级后 π̄ 变化影响 trust 尺度？）；观测端发现漂移即可用
 * SCORE_TRUST_THRESHOLD 参数化调整（先落盘后进生产）。
 */
export function trustDistributionStats(values) {
  const v = (Array.isArray(values) ? values : [])
    .filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const p = (q) => {
    const k = (sorted.length - 1) * q;
    const f = Math.floor(k);
    const c = Math.ceil(k);
    if (f === c) return sorted[k];
    return sorted[f] * (c - k) + sorted[c] * (k - f);
  };
  return {
    count: v.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: v.reduce((s, x) => s + x, 0) / v.length,
    p10: p(0.1),
    p50: p(0.5),
    p90: p(0.9),
  };
}

// ── 注入瘦身四刀（2026-09-21，修复单：治注入端肥胖/陈旧/重复）──────────────
// 现场（2026-09-21 10:44 一次真实醒来）：焦点记忆 7 条里 2-6 条同话题（"自主醒来
// 没反应"）且全是 8 月历史长文（每条数百字全文）；[记忆系统自述] 含"激活节点"
// 清单被重复 4 遍、[行动] 暂缓意向、[信息性标注…] 直接进注入。净效果 = 真记忆
// 被稀释、上下文被烧、看着像原地打转。根因：召回 query = 醒因原文 → 每次都被
// 召回"最像醒因那段话"的陈旧长文（只读定位见 memory-recall.js / extractQueryText
// 与 buildContextText）。四刀 = 剔机器自述 / 同段去重 / 真记忆去冗 / 陈旧降权，
// **各自可关、fail-open（任何一项抛错退旧行为，绝不阻断注入）**。
// 边界（任务书纪律）：不改 LMS 检索语义、不动沙漏数据、不改唤醒出口——四刀全部
// 是**注入端消费者侧**的重排/过滤，只改"拼进上下文的那段文本"，不回写任何库。
//
// 词表复用：与 lms-core/message_markers.py 的机器标记语义对齐（跨语言不 import，
// 此处登记同一批字面量；新增标记先在该 py 与此处同步，防字面漂移）。
const MACHINE_NARRATION_MARKERS = [
  "[记忆系统自述]", "激活节点", "[信息性标注", "NO_REPLY",
  "[回魂]", "[行动]", "[生成约束]", "[记忆注入]",
  "🌙【梦中醒来】", "📬【信箱新消息】", "【信箱·新留言】",
  "[wake-bridge]", "[lms-memory]", "[心跳]",
  "[Subagent Context]", "[Inter-session message]", "[cron:",
  "取代先前的快照", "你是思考链的【后台思考者】",
  // 第五刀（2026-09-21）：右脑【重理解】= 机器对用户话的**二次解析**（机器制品，
  // 虽带 [dandan] 来源标签也**不冒充用户原话**）——现场它仍占注入位（`最近:【重理解】…`）。
  // 单一来源：与 message_markers.py 的 PRODUCER_PAYLOADS 同族（重理解产出）。
  "【重理解】",
];

/** 机器自述判定（纯函数）：条目/自述文本是否机器产物（非人类原话）。
 * 命中任一标记即判机器——用于焦点记忆条目、self_ref 自述、行动层文本。
 * fail-open：非字符串/空 → true（空内容无注入价值，等同剔除）。
 */
export function isMachineNarration(text) {
  if (typeof text !== "string") return true;
  const t = text.trim();
  if (!t) return true;
  return MACHINE_NARRATION_MARKERS.some((m) => t.includes(m));
}

/** 段级机器标记清洗（纯函数）：移除行内的 [信息性标注：…] 段（熵饱和区诊断
 * 标注，机器产物），并收拾残留的分隔符（避免 "｜｜" / 尾随 "｜"）。
 * 用于【回魂】段里的景观叙事——只剃标注段，不碰读数本身。
 */
export function scrubMachineSegments(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(/\[信息性标注：[^\]]*\]/g, "")
    .replace(/｜{2,}/g, "｜")
    .replace(/｜\s*(?=\/|$)/g, "")
    .replace(/\s*｜\s*$/, "")
    .trim();
}

/** 第六刀（2026-09-21）：【回魂】整段的机器噪音清洗（纯函数，兼底闸）。
 *
 * 【回魂】段是**人可读身份+状态**（自述/状态/景观/最近）；其中可能混进机器噪声：
 * 模板 token、【重理解】（右脑对用户话的二次解析）、[记忆系统自述] / [行动] /
 * [生成约束] / [信息性标注…] / NO_REPLY、`激活节点:` 清单。
 * 本函数整段移除上述噪声；**保留**：[回魂] 头、自述人话、状态读数（熵/惊讶/目的/
 * 轮次）、景观读数（含缺口行）、最近段人类文本。
 *
 * 为何不直接复用 isMachineNarration：它把含 "[回魂]" 判为机器（因为要防
 * 焦点条目里出现回魂横幅），不能拿它判**回魂段自己**。故此处用“按标记点名、
 * 到段分隔符（" / "）为止”的定点剔法；且**绝不剔除读数数字**（与 scrubMachineSegments
 * 同纪律：只剃机器段，不碰读数本身）。
 * fail-open：非字符串/异常 → 原样返回。
 */
export function stripMachineNoiseFromSoul(text) {
  if (typeof text !== "string" || !text) return text;
  try {
    // 按段分隔符 " / " 切段后**段内**剔——预防截断后的未闭合标记（如景观被
    // slice 截掉尾 "］"）跨越段边界吃掉后面的段落（生产实测：熵饱和区探测段
    // >200 字被截 ⇒ "[信息性标注：…" 无尾括号）。
    const cleanSeg = (seg) => seg
      .replace(/<\|[\w-]{1,40}\|>/g, "")                        // 运行时模板 token
      .replace(/【重理解】[^｜\n]*/g, "")                        // 右脑二次解析段
      .replace(/\[记忆系统自述\][^｜\n]*/g, "")                  // 机器自述段
      .replace(/\[行动\][^｜\n]*/g, "")                          // 行动层段
      .replace(/\[生成约束\][^｜\n]*/g, "")                      // 生成约束段
      .replace(/\[记忆注入\][^｜\n]*/g, "")                      // 记忆块横幅（若误入）
      .replace(/\[信息性标注[^\]｜\n]*\]?/g, "")                // 信息性标注（含未闭合；保留读数）
      .replace(/激活节点[:：][^｜\n]*/g, "")                     // 激活节点清单（带冒号才是清单）
      .replace(/NO_REPLY/g, "")                                // 哨兵终止符
      .replace(/｜{2,}/g, "｜")                                  // 剔空后的空子段塌缩
      .replace(/^\s*｜|｜\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    const segs = String(text).split(/\s+\/\s+/).map(cleanSeg).filter((s) => s.length > 0);
    return segs.length === 0 ? "" : segs.join(" / ");
  } catch {
    return text; // fail-open：清洗失败退原样（宁可多留噪声，不可误删回魂）
  }
}

/** 结构指纹（纯函数）：剔数字 + 去空白。用于识别"同形状、仅编号不同"的
 * 近重复（实测 self_ref 4 条仅"节点N"编号不同 → 应折叠为 1 条）。
 */
export function narrationFingerprint(text) {
  return String(text || "").replace(/\d+/g, "#").replace(/\s+/g, "");
}

/** 解析注入端卫生参数（四刀开关 + 阈值）。
 * 优先级：pluginConfig 字段 > env（INJECT_*）> 默认（全开）。
 * 无效值回退默认（fail-open：解析异常绝不关掉所有刀）。
 */
export function resolveInjectHygiene(env, cfg) {
  const e = env && typeof env === "object" ? env : {};
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const bool = (v, dflt) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (/^(0|false|no|off)$/i.test(v.trim())) return false;
      if (/^(1|true|yes|on)$/i.test(v.trim())) return true;
    }
    return dflt;
  };
  const num = (v, dflt, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const pick = (key, envKey) => (c[key] !== undefined ? c[key] : e[envKey]);
  // 第六刀（2026-09-21）：唤醒轮「只注回魂」模式——off / soul（默认）/ full。
  // off = 第五刀行为（唤醒轮什么都不注）；soul = 只注【回魂】人可读段；full = 全注
  // （该轮不剥 query，退第四刀前行为）。解析容错：boolean true→soul / false→off；
  // 无效值 → soul（fail-open：宁可注回魂，不可静默什么都不注）。
  const wakeMode = (() => {
    const raw = pick("soulOnlyWake", "INJECT_SOUL_ONLY_WAKE");
    if (raw === undefined || raw === null || raw === "") return "soul";
    if (typeof raw === "boolean") return raw ? "soul" : "off";
    const s = String(raw).trim().toLowerCase();
    if (["off", "0", "false", "no", "none", "null"].includes(s)) return "off";
    if (["full", "all"].includes(s)) return "full";
    return "soul"; // soul / on / true / 1 / 无效值
  })();
  return {
    stripMachineQuery: bool(pick("stripMachineQuery", "INJECT_STRIP_MACHINE_QUERY"), true),
    soulOnlyWake: wakeMode,
    stripMachineNarration: bool(pick("stripMachineNarration", "INJECT_STRIP_MACHINE_NARRATION"), true),
    dedupeNearDuplicates: bool(pick("dedupeNearDuplicates", "INJECT_DEDUPE_NEAR_DUPLICATES"), true),
    dedupeSimilarity: num(pick("dedupeSimilarity", "INJECT_DEDUPE_SIMILARITY"), 0.75, 0.1, 1),
    dedupeMinSharedChars: Math.round(num(pick("dedupeMinSharedChars", "INJECT_DEDUPE_MIN_SHARED_CHARS"), 24, 4, 400)),
    entryTruncate: bool(pick("entryTruncate", "INJECT_ENTRY_TRUNCATE"), true),
    entryMaxChars: Math.round(num(pick("entryMaxChars", "INJECT_ENTRY_MAX_CHARS"), 400, 40, 4000)),
    entryTruncateTailChars: Math.round(num(pick("entryTruncateTailChars", "INJECT_ENTRY_TRUNCATE_TAIL_CHARS"), 60, 0, 400)),
    recencyWeight: bool(pick("recencyWeight", "INJECT_RECENCY_WEIGHT"), true),
    recencyHalfLifeDays: num(pick("recencyHalfLifeDays", "INJECT_RECENCY_HALF_LIFE_DAYS"), 14, 0.5, 3650),
    recencyFloor: num(pick("recencyFloor", "INJECT_RECENCY_FLOOR"), 0.25, 0.01, 1),
  };
}

/** 条目时间戳解析（纯函数）：glue /recall 每条带 ts——lms 条目 = entry.ts（unix
 * 秒，数值）；沙漏条目 = "YYYY-MM-DD HH:MM:SS" 字符串（可能解析失败）。
 * 数值/字符串都拿不到时回落条目文本里首个 YYYY-MM-DD；全无 → null（中性，
 * 不降权——fail-open：宁可不过滤也不误杀）。
 */
export function parseEntryTimestamp(it) {
  if (!it || typeof it !== "object") return null;
  const ts = it.ts;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 1e12 ? ts : ts * 1000; // >1e12 视为毫秒，否则秒
  }
  if (typeof ts === "string") {
    const m = ts.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
      const t = d.getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  const txt = typeof it.text === "string" ? it.text : "";
  const tm = txt.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (tm) {
    const d = new Date(Number(tm[1]), Number(tm[2]) - 1, Number(tm[3]));
    const t = d.getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** 时效降权因子（纯函数，cut d）：f = halfLife / (halfLife + ageDays)，
 * 夹到 [floor, 1]。老条目降权（非禁止），地板保证"旧"不等于"消失"。
 * 无时间戳 → 1（中性，fail-open 不误杀）。
 */
export function recencyFactor(tsMs, nowMs, halfLifeDays, floor) {
  if (!Number.isFinite(tsMs) || !Number.isFinite(nowMs)) return 1;
  const hl = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 14;
  const fl = Number.isFinite(floor) && floor > 0 && floor <= 1 ? floor : 0.25;
  const ageDays = Math.max(0, (nowMs - tsMs) / 86400000);
  const f = hl / (hl + ageDays);
  return Math.max(fl, Math.min(1, f));
}

/** 条目截断（纯函数，cut c）：超上限 → 头部 + "…" + 尾部（保留结论），
 * 保证总长 ≤ maxChars。只作用于**注入文本**，不改原文存档（任务书红线）。
 */
export function truncateEntryText(text, maxChars, tailChars) {
  const t = typeof text === "string" ? text : "";
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 400;
  if (t.length <= cap) return t;
  const tail = Number.isFinite(tailChars) && tailChars > 0 ? Math.floor(tailChars) : 0;
  if (tail <= 0 || cap <= 1) return `${t.slice(0, Math.max(0, cap - 1))}…`;
  const headLen = Math.max(0, cap - tail - 1);
  return `${t.slice(0, headLen)}…${t.slice(t.length - tail)}`;
}

/** 共享子串检测（纯函数）：a 中是否有长度 ≥ minChars 的子串出现在 b 中。
 * 用于近重复判定（比 bigram Jaccard 更能抓住"一段长文本被整体复制"）。
 */
function hasSharedSubstring(a, b, minChars) {
  const A = String(a || "");
  const B = String(b || "");
  const n = Math.max(2, Math.floor(minChars));
  if (A.length < n || B.length < n) return false;
  for (let i = 0; i + n <= A.length; i += 1) {
    if (B.includes(A.slice(i, i + n))) return true;
  }
  return false;
}

/** 同段去重（纯函数，cut b）：一次注入内，"同一段/同一指纹"只留一份。
 * 判据（任一命中即近重复，保留 weight 更高的那条）：
 *   ① 数字归一化后结构指纹相同（self_ref 4 条仅节点编号不同 → 折叠 1 条）；
 *   ② 数字归一化后 bigram Jaccard ≥ sim（改写式近重复）；
 *   ③ 共享连续子串 ≥ minSharedChars（长文被整段复制）。
 * 输入 items 假定已含 {text, weight}；返回新数组（不原地改）。fail-open：
 * 空/异常 → 原样返回。
 */
export function dedupeNearDuplicateItems(items, sim = 0.75, minSharedChars = 24) {
  if (!Array.isArray(items) || items.length <= 1) return items || [];
  const ordered = [...items].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const kept = [];
  for (const it of ordered) {
    const norm = narrationFingerprint(it.text);
    const bi = bigramSet(norm);
    let dup = false;
    for (const k of kept) {
      if (norm && norm === narrationFingerprint(k.text)) { dup = true; break; }
      const kb = k._bigrams || bigramSet(narrationFingerprint(k.text));
      let jac = 0;
      if (bi.size > 0 && kb.size > 0) {
        let hit = 0;
        for (const g of bi) if (kb.has(g)) hit += 1;
        const union = bi.size + kb.size - hit;
        jac = union > 0 ? hit / union : 0;
      }
      if (jac >= sim) { dup = true; break; }
      if (hasSharedSubstring(norm, narrationFingerprint(k.text), minSharedChars)) { dup = true; break; }
    }
    if (!dup) {
      const copy = { ...it, _bigrams: bi };
      kept.push(copy);
    }
  }
  return kept.map(({ _bigrams, ...rest }) => rest);
}

// 注入卫生观测日志（与 logMiss 同模式；日志失败绝不影响主流程）。
function logHygiene(stats) {
  try {
    appendFileSync(
      DEBUG_LOG_FILE,
      `[${new Date().toISOString()}] HYGIENE machine=${stats.machine} dup=${stats.dup}`
        + ` trunc=${stats.trunc} recency=${stats.recency} kept=${stats.kept}`
        + ` chars=${stats.chars}\n`,
    );
  } catch { /* 日志失败忽略：不引入新崩溃点 */ }
}

// P1-2 观测日志（与 logMiss 同模式；日志失败绝不影响主流程）
let scoreParamsLogged = false;
function logScoreParams(sp) {
  if (scoreParamsLogged) return; // 每进程一次（参数先落盘）
  scoreParamsLogged = true;
  try {
    appendFileSync(
      DEBUG_LOG_FILE,
      `[${new Date().toISOString()}] SCORE-PARAMS alpha=${sp.scoreAlpha.toFixed(2)} beta=${sp.scoreBeta.toFixed(2)} mode=${sp.doubtMode} trust_threshold=${sp.trustThreshold.toFixed(2)} downgrade_factor=${SCORE_DOWNGRADE_FACTOR} consistency_default=${CONSISTENCY_STATIC_DEFAULT}\n`,
    );
  } catch { /* 日志失败忽略 */ }
}
function logTrustDist(stats, untagged) {
  if (!stats) return;
  try {
    appendFileSync(
      DEBUG_LOG_FILE,
      `[${new Date().toISOString()}] TRUST-DIST tagged_n=${stats.count} min=${stats.min.toFixed(3)} max=${stats.max.toFixed(3)} mean=${stats.mean.toFixed(3)} p10=${stats.p10.toFixed(3)} p50=${stats.p50.toFixed(3)} p90=${stats.p90.toFixed(3)} untagged=${untagged}\n`,
    );
  } catch { /* 日志失败忽略 */ }
}
function logScoreDoubt(mode, trust, before, after, annotated, snippet) {
  try {
    appendFileSync(
      DEBUG_LOG_FILE,
      `[${new Date().toISOString()}] SCORE-DOUBT mode=${mode} trust=${Number(trust).toFixed(2)} score=${Number(before).toFixed(4)}->${Number(after).toFixed(4)} annotated=${annotated} text=${String(snippet).slice(0, 30)}\n`,
    );
  } catch { /* 日志失败忽略 */ }
}

// ── 阶段 2 步骤 4（P1-3 注入时验证链，2026-08-16，定稿 v2 §六）────────────
// 高 stakes 可操作化（R6）→ CoVe 轻量验证链（草稿→独立验证→修正）→
// [doubt] conflict 写 /feed → doubt_ingest conflict 事件 → mark_labile
// （Nader 2000 再巩固入口）。
//
// 独立验证防伪独立（R6，代码级四条保证）：
//   ① 端点不同：草稿批次 = glue POST /recall（cfg.glueUrl）；验证批次 =
//      LMS POST /recall 直调（cfg.lmsUrl）
//   ② query 不同：草稿 = 用户 query（extractQueryText 产物）；验证 = 记忆
//      条目文本（H/E）派生——代码路径上用户 query 不进验证调用
//   ③ 批次不同：独立 fetch 调用 = 独立采样批次；V1（H 复现）/V2（E 复现）
//      并行互不共享结果
//   ④ 附加独立信号：LMS recall-time consistency + doubt_verdict（conformal
//      分位怀疑线判定，LMS 侧计算）；黑盒降级 = 多采样一致性（验证失败
//      → 不确认，不写）
//
// provenance 防回声（R6）：
//   防线 1：detectHighStakes 排除 [doubt] 前缀条目（系统事件非候选、非参照）
//   ——验证链自身产物（[doubt] conflict 事件）不会被当作新事实再验证
//   防线 2：VERIFY-* 日志含（输入/验证源/结果/时间戳）——产物可追溯
//   防线 3：写侧幂等（P1 修复根因 3：乐观窗口 + 写前查重 + done 永久幂等，
//     见 writeDoubtConflict 注释——旧“成功才记窗口”已被 60s 竞态实弹证伪）
//
// P1 修复（2026-08-16 审计三根因，四妹 §二，步骤 4 重审前置）：
//   根因 1（overlapMatch 纯子串碰撞）：stripVerifyMetadata 排除时间戳/日期/
//     System 前缀等元数据（结构化字段直接剔除，不做子串匹配）——实弹案例
//     "[Thu 2026-08-06 00:11 GMT+8] 开工吧" vs "System: [...] Gate" 不再触发。
//     方案：共享片段(≥5字保留)+排除元数据+否定词极性判定组合（插件无
//     embedding 通道——嵌入需 HTTP+跨机 Ollama 依赖，破坏零开销契约）。
//   根因 2（hRepro&&eRepro 只证存在不证矛盾）：命中后追加 isContradictionPair
//     ——方向性相反/数值差异超阈值/否定词极性翻转三选一才登记冲突。
//   根因 3（60s 幂等竞态）：乐观窗口 + verifyIngested 查重（/recall 只读）+ 
//     done 永久幂等 + attempts 封顶——超时后先查重再判“未写入”。
//   验证链默认开启（verifyChainEnabled 默认 true——P1 三根因修复重审正式通过
//     后灰度开启；快速回滚 = 插件配置 verifyChainEnabled:false 一行）。
//
// 零开销契约：无高 stakes → 零 HTTP、零日志、注入面零改动（纯函数判定）。

// ── P1-3 修复（根因 1，审计 2026-08-16）：overlapMatch 元数据排除 ──
// 实弹案例（审计 12:53:10）："[Thu 2026-08-06 00:11 GMT+8] 开工吧" vs
// "System: [2026-08-06 00:23:49 GMT+8] Gate"——共享片段 "[2026-08-06 00:"
// 纯为时间戳元数据，零语义冲突仍被 confirmed。修复：子串比对前剥离元数据
// （时间戳/日期/时钟/System 前缀等结构化字段——直接剔除，不做子串匹配），
// 结构化字段不再参与共享片段判定。方案选择（四妹 §二-1 许可分支）：插件无
// embedding 通道（thought 激活度是 bigram 关键词法；LMS embedding 在服务端
// 且依赖跨机 Ollama bge-m3，热路径不可依赖）→ 用“共享片段 + 排除元数据 +
// 否定词极性判定组合”，不加 HTTP/不新增依赖（embedding 方案会破坏零开销
// 契约——无 stakes 也要网络调用，与既有“热路径不加 embed”设计冲突）。

/** 剥离验证比对用的元数据字段（时间戳/日期/时钟/System 前缀/星期标记等）。
 * 只剥结构化字段：①方括号内含日期/时钟的时间戳块（[Thu 2026-08-06 …]）
 * ②裸 ISO 日期时间 ③时钟（时:分[:秒]）④System:/[System] 前缀 ⑤GMT/UTC 偏移
 * ⑥英文星期标记。非时间戳方括号内容（[doubt]/[行动]/[生成约束]）保留——
 * 那些是内容标记不是元数据。纯函数、幂等、零依赖。 */
export function stripVerifyMetadata(text) {
  if (typeof text !== "string" || !text) return "";
  let out = text;
  // 方括号时间戳块（内含日期或时钟）：[Thu 2026-08-06 00:11 GMT+8]
  out = out.replace(/\[[^\]]*\d{4}-\d{2}-\d{2}[^\]]*\]/g, " ");
  out = out.replace(/\[[^\]]*\d{1,2}:\d{2}(?::\d{2})?[^\]]*\]/g, " ");
  // 裸 ISO 日期时间 / 时钟 / GMT-UTC 偏移 / 英文星期
  out = out.replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g, " ");
  out = out.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  out = out.replace(/\b(?:GMT|UTC)[+-]?\d*\b/gi, " ");
  out = out.replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/gi, " ");
  // System 前缀（openclaw 系统消息标记）
  out = out.replace(/^\s*(?:System|系统)\s*[:：]\s*/g, " ");
  out = out.replace(/\[System\]/gi, " ");
  return out.replace(/\s+/g, " ").trim();
}

/** 找共享片段（元数据排除后）：返回 {frag, posA, posB}（pos 为各自元数据排除
 * 后文本中的位置）或 null。滑动窗扫描（与原 overlapMatch 同法）——找的是
 * 连续公共子串，不是子序列；minLen=5 防 2-3 字高频词伪冲突。 */
function findSharedFragment(a, b, minLen) {
  if (typeof a !== "string" || typeof b !== "string") return null;
  const na = normalizeEntryKey(stripVerifyMetadata(a));
  const nb = normalizeEntryKey(stripVerifyMetadata(b));
  if (!na || !nb) return null;
  const short = na.length <= nb.length ? na : nb;
  const long = short === na ? nb : na;
  const shortIsA = short === na;
  if (short.length < minLen) return null;
  for (let i = 0; i <= short.length - minLen; i += 1) {
    const frag = short.slice(i, i + minLen);
    const j = long.indexOf(frag);
    if (j !== -1) {
      return { frag, posA: shortIsA ? i : j, posB: shortIsA ? j : i };
    }
  }
  return null;
}

/** 共享片段匹配（_find_overlapping_entry 工程匹配的扩展，无 LLM）：
 * 归一化（剥 ⚠️置信 标注 + 折叠空白）+ 元数据排除（stripVerifyMetadata——
 * P1 修复根因 1：时间戳/日期/System 前缀等结构化字段直接剔除，不做子串匹配）
 * 后，任一方存在 ≥minLen 的连续片段出现在另一方 → true。原函数是纯包含
 * （needle ∈ text 或 text[:120] ∈ needle），用于证伪时找重叠条目（content 是
 * 条目文本摘要，天然包含）；用于注入冲突检测会漏掉"前缀相同、取值相反"的
 * 真实冲突对（如"生日是8月30日" vs "生日是8月15日"），故扩展为共享片段。
 * minLen=VERIFY_OVERLAP_MIN(5)：中文 5 字 ≈ 语义短语；防 2-3 字高频词
 * （"用户""生日"）伪冲突。 */
export function overlapMatch(a, b, minLen = VERIFY_OVERLAP_MIN) {
  return findSharedFragment(a, b, minLen) !== null;
}

/** 高 stakes 判定（纯函数，R6 可操作化，定稿 v2 §六-1）。
 * 输入：/recall 响应 results（注入候选批）+ env（STAKE_TOPICS 白名单）。
 * ①冲突：候选条目与同批高信任条目（trust ≥ HIGH_TRUST_MIN：无 ⚠️标注 =
 *   默认 1.0，integration_service 只注 confidence<0.5 → 高信任≈未标注）
 *   共享 ≥VERIFY_OVERLAP_MIN 字片段；②敏感话题：候选文本含白名单关键词。
 * [doubt] 前缀条目（系统事件）双向排除（防回声防线 1）。
 * 返回 [{candidate, highTrustMatch, reason}]；reason: "conflict" | "topic"。
 * 无高 stakes → []（调用方零开销）。 */
export function detectHighStakes(results, env) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const e = env && typeof env === "object" ? env : {};
  const topicsRaw = String(e.STAKE_TOPICS || "").trim();
  const topics = topicsRaw
    ? topicsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const entries = results
    .map((it) => ({
      text: typeof it?.text === "string"
        ? it.text.trim().replace(/\s+/g, " ") : "",
      trust: parseConfidenceTag(it?.text) ?? 1.0,
      raw: it,
    }))
    .filter((x) => x.text && !VERIFY_DOUBT_PREFIX_RE.test(x.text));
  const out = [];
  const seen = new Set();
  for (const cand of entries) {
    // ② 敏感话题白名单（env STAKE_TOPICS；默认空 = 全走冲突判定）
    if (topics.length > 0 && topics.some((t) => cand.text.toLowerCase().includes(t))) {
      const k = `topic:${normalizeEntryKey(cand.text)}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ candidate: cand.raw, highTrustMatch: null, reason: "topic" });
      }
      continue;
    }
    // ① 冲突：候选 vs 高信任条目（共享片段；同文重复是 P1-2 去重职责，非冲突）
    if (entries.length < 2) continue;
    for (const h of entries) {
      if (h === cand) continue;
      if (h.trust < HIGH_TRUST_MIN) continue;
      if (h.text === cand.text) continue;
      if (!overlapMatch(cand.text, h.text)) continue;
      const k = `conflict:${normalizeEntryKey(cand.text)}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ candidate: cand.raw, highTrustMatch: h.raw, reason: "conflict" });
      }
    }
  }
  return out;
}

// ── P1-3 修复（根因 2，审计 2026-08-16）：hRepro&&eRepro 追加矛盾判定 ──
// 旧确认判据 confirmed = hRepro && eRepro 只证明“双方都存在于记忆”，不证明
// “二者矛盾”（短条目按自身文本检索必然自复现 → 假确认；实弹 12:52:56
// “跑偏了” vs “批评我两天”对即此）。修复：命中（hRepro&&eRepro）后必须追加
// 矛盾判定——三选一成立才登记冲突：
//   ①方向性相反（正/负极性）：netPolarity 一正一负（否定词翻转极性字）
//   ②数值差异超阈值：共享片段上下文窗（±20 字）内数值集合存在差异
//      （“生日8月30日” vs “生日8月15日” → 30≠15；阈值参数化，默认 0）
//   ③否定词极性翻转：共享片段边界 ±3 字内一侧有否定词另一侧没有
//      （“喜欢下雨” vs “不喜欢下雨”；“没有自主行动” vs “有自主行动”）
// “双方存在”只是前提不是结论。语义互补对（同为负向陈述，如“跑偏了” vs
// “批评我两天没有自主行动”）三规则全不命中 → 不判冲突（灵魂指标②）。
// 全部纯函数、零 HTTP、零依赖（无 embedding——见 stripVerifyMetadata 注释
// 的方案选择理由）；只在 runVerifyChain 确认步调用（无 stakes 零开销）。

const POLARITY_POSITIVE = new Set([
  "喜欢", "欣赏", "爱", "优秀", "出色", "正确", "对", "支持", "同意", "成功",
  "开心", "高兴", "满意", "乐观", "积极", "肯定", "信任", "相信", "顺利",
  "有利", "适合", "认可", "合理", "值得", "希望", "靠谱", "完美", "漂亮",
  "聪明", "健康", "安全", "稳定", "幸福", "欣慰", "期待", "放心", "理解",
  "赞", "棒", "好",
]);
const POLARITY_NEGATIVE = new Set([
  "讨厌", "恨", "坏", "差", "错", "错误", "反对", "不同意", "失败", "难过", "伤心",
  "悲观", "消极", "否定", "批评", "责备", "抱怨", "怀疑", "糟糕", "不利",
  "不适合", "否认", "不合理", "不值得", "失望", "跑偏", "离谱", "误导",
  "危险", "恐惧", "焦虑", "担忧", "麻烦", "痛苦", "愤怒", "生气", "崩溃",
  "混乱", "低效", "缺陷", "漏洞", "风险", "荒谬", "荒唐",
]);
// 否定词表（刻意不含“非/别/未/无”之外的常见误伤：非常/特别/未来/无比）。
// 保留 无（无风险/无行动），风险点（无论/无比）需 ≥5 字共享片段+极性字邻近才
// 可能误判，且规则①还要求两侧极性相反，误报面有界。
const NEGATION_RE = /(?:不|没|未|无|莫|勿|休|甭|没有|不是|不能|不会|不再|从不|毫不|未曾|未必)/;

/** 净极性分（启发式）：极性词计数，紧邻前 3 字内的否定词翻转该词极性。
 * 如“不喜欢”→ 喜欢(+1) 被 不 翻转 → -1；“很不错”→ 错(-1) 被翻转 → +1。
 * 纯启发式：不进注入面，只作矛盾判定三规则之一。 */
function polarityScore(text) {
  let net = 0;
  const scan = (words, sign) => {
    for (const w of words) {
      let idx = text.indexOf(w);
      while (idx !== -1) {
        const before = text.slice(Math.max(0, idx - VERIFY_NEGATION_NEAR_CHARS), idx);
        const negated = NEGATION_RE.test(before);
        net += negated ? -sign : sign;
        idx = text.indexOf(w, idx + w.length);
      }
    }
  };
  scan(POLARITY_POSITIVE, 1);
  scan(POLARITY_NEGATIVE, -1);
  return net;
}

/** 共享片段上下文窗内数值集合（±20 字；元数据已在 stripVerifyMetadata 剥离，
 * “8月30日”这类内容日期数字保留）。中文数词（两天/三次）不抽取——防“批评我
 * 两天”类互补对误判。 */
function numbersInWindow(text, fragStart, fragLen, radius = 20) {
  const from = Math.max(0, fragStart - radius);
  const to = Math.min(text.length, fragStart + fragLen + radius);
  const window = text.slice(from, to);
  const out = [];
  for (const m of window.matchAll(/(\d+(?:\.\d+)?)/g)) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** 规则②：共享片段上下文窗数值差异超阈值（默认 0 = 任何差异即矛盾）。 */
function numericConflict(na, nb, threshold) {
  const frag = findSharedFragment(na, nb, VERIFY_OVERLAP_MIN);
  if (!frag) return false;
  const aNums = numbersInWindow(na, frag.posA, frag.frag.length);
  const bNums = numbersInWindow(nb, frag.posB, frag.frag.length);
  if (aNums.length === 0 || bNums.length === 0) return false;
  let maxDiff = 0;
  for (const x of aNums) {
    for (const y of bNums) maxDiff = Math.max(maxDiff, Math.abs(x - y));
  }
  return maxDiff > threshold;
}

/** 规则③：共享片段边界 ±N 字内否定词状态不同（一侧有、另一侧无）→ 翻转。
 * 只计“自由否定”（后随 2 字内不是极性词的否定）：紧贴极性词的否定（不错/
 * 不好/不喜欢）是该极性词的内部否定——由规则①（polarityScore 否定翻转）处理，
 * 不在此重复计（防“很棒 vs 很不错”伪翻转——两侧同为正面不判冲突）。
 * 两侧都有自由否定（不同词也算，如“没有行动” vs “无行动”）→ 同态，不判。
 * 否定必须紧贴片段（±3 字）——远处否定（“dandan：批评我两天没有自主行动”
 * 对“dandan：你们都完全跑偏了”，共享片段为前缀时“没有”在远处）不算，防
 * “双方存在”类伪矛盾。 */
function countFreeNegations(window) {
  let n = 0;
  const re = new RegExp(NEGATION_RE.source, "g"); // 局部 g 标志，不动全局 NEGATION_RE
  let m;
  while ((m = re.exec(window)) !== null) {
    const after = window.slice(m.index + m[0].length, m.index + m[0].length + 2);
    const followedByPolarity = [...POLARITY_POSITIVE, ...POLARITY_NEGATIVE]
      .some((w) => after.startsWith(w));
    if (!followedByPolarity) n += 1;
  }
  return n;
}

function negationFlip(na, nb, frag) {
  const count = (text, pos) => {
    const before = text.slice(Math.max(0, pos - VERIFY_NEGATION_NEAR_CHARS), pos);
    const after = text.slice(
      pos + frag.frag.length,
      pos + frag.frag.length + VERIFY_NEGATION_NEAR_CHARS,
    );
    return countFreeNegations(before) + countFreeNegations(after);
  };
  const ca = count(na, frag.posA);
  const cb = count(nb, frag.posB);
  return (ca > 0) !== (cb > 0);
}

/** 规则①：净极性相反（一正一负）。同负/同正/中性 → 不判（“跑偏了”与
 * “批评我两天”同为负向 → 不冲突——语义互补而非矛盾，灵魂指标②）。 */
function polarityOpposite(na, nb) {
  const sa = polarityScore(na);
  const sb = polarityScore(nb);
  return (sa > 0 && sb < 0) || (sa < 0 && sb > 0);
}

/** 矛盾判定（纯函数，P1 修复根因 2）：共享片段存在的前提下三选一——
 * ①方向性相反（正/负极性）②数值差异超阈值 ③否定词极性翻转。
 * 任一成立 → 矛盾（true）；无共享片段 / 三规则全不命中 → false。
 * “双方存在”（hRepro&&eRepro）只是前提，本函数才是“矛盾”的结论。 */
export function isContradictionPair(a, b, opts = {}) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const frag = findSharedFragment(a, b, VERIFY_OVERLAP_MIN);
  if (!frag) return false;
  const na = normalizeEntryKey(stripVerifyMetadata(a));
  const nb = normalizeEntryKey(stripVerifyMetadata(b));
  const threshold = Number.isFinite(opts.numDiffThreshold)
    ? opts.numDiffThreshold : VERIFY_NUM_DIFF_THRESHOLD;
  if (numericConflict(na, nb, threshold)) return true;
  if (negationFlip(na, nb, frag)) return true;
  if (polarityOpposite(na, nb)) return true;
  return false;
}

/** 独立验证检索（CoVe 验证步）：直调 LMS POST /recall（只读，同 P1-2
 * 窄路径端点：count_reference=False 零持久化）。
 * 返回 [{text, consistency, adaptiveConfidence, doubtVerdict}]；
 * 失败/超时/非 2xx → null（fail-open，黑盒降级 = 不确认）。 */
export async function fetchLmsVerify(cfg, queryText) {
  const url = `${cfg.lmsUrl}/recall`;
  // P1 修复：超时可配（cfg.verifyTimeoutMs，测试加速用；缺省走模块常量）
  const timeoutMs = Number.isFinite(cfg && cfg.verifyTimeoutMs) && cfg.verifyTimeoutMs > 0
    ? cfg.verifyTimeoutMs : VERIFY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: String(queryText || "").slice(0, QUERY_MAX_CHARS),
        k: VERIFY_K_DEFAULT,
        session_id: cfg.landscapeSid || LANDSCAPE_SID,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logMiss(`verify-non-2xx status=${resp.status} url=${url}`);
      return null;
    }
    const data = await resp.json();
    const results = Array.isArray(data && data.results) ? data.results : [];
    return results.map((r) => ({
      text: String((r && r.text) || "").trim(),
      consistency: typeof r.consistency === "number" ? r.consistency : null,
      adaptiveConfidence: typeof r.adaptive_confidence === "number"
        ? r.adaptive_confidence : null,
      doubtVerdict: r.doubt_verdict === true,
    }));
  } catch (err) {
    const why = err && err.name === "AbortError" ? "timeout" : "network-error";
    logMiss(`verify-${why} url=${url} timeoutMs=${timeoutMs}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// P1-3 provenance 日志（VERIFY-*：输入/验证源/结果/时间戳；同 logMiss 模式，
// 日志失败绝不影响主流程）。candidate/highTrust/query 截 40 字（防刷屏）。
function logVerify(kind, fields) {
  try {
    const bits = Object.entries(fields || {}).map(([k, v]) => {
      if (k === "candidate" || k === "highTrust" || k === "query"
          || k === "queryV1" || k === "queryV2") {
        return `${k}=${JSON.stringify(String(v).slice(0, 40))}`;
      }
      return `${k}=${v}`;
    });
    appendFileSync(DEBUG_LOG_FILE, `[${new Date().toISOString()}] VERIFY-${kind} ${bits.join(" ")}\n`);
  } catch { /* 日志失败忽略 */ }
}

// P1-3 参数先落盘（R8 纪律）：常量 + STAKE_TOPICS 白名单，每进程一次。
let verifyParamsLogged = false;
function logVerifyParams() {
  if (verifyParamsLogged) return;
  verifyParamsLogged = true;
  try {
    const topics = String(process.env.STAKE_TOPICS || "").trim()
      || "(empty=conflict-only)";
    appendFileSync(
      DEBUG_LOG_FILE,
      `[${new Date().toISOString()}] VERIFY-PARAMS max_chains=${VERIFY_MAX_CHAINS} k=${VERIFY_K_DEFAULT} timeout_ms=${VERIFY_TIMEOUT_MS} overlap_min=${VERIFY_OVERLAP_MIN} high_trust_min=${HIGH_TRUST_MIN} write_dedup_ms=${VERIFY_WRITE_DEDUP_MS} max_write_attempts=${VERIFY_MAX_WRITE_ATTEMPTS} num_diff_threshold=${VERIFY_NUM_DIFF_THRESHOLD} negation_near_chars=${VERIFY_NEGATION_NEAR_CHARS} stake_topics=${JSON.stringify(topics)}\n`,
    );
  } catch { /* 日志失败忽略 */ }
}

// 写侧幂等窗口（normalizedKey → {ts, state, attempts, id}）。P1-3 修复（根因 3）：
// 旧实现“成功才记窗口”——服务端已摄入但客户端 4s 超时 → ok=false → 不记窗口 →
// 下轮重写 → rebuttal 放大（实况 14 次重写）。修复：
//   - 窗口按“写尝试”乐观记录（写前先记 pending，超时也不丢窗口）
//   - state: "done"（服务端 200 确认，永久幂等——防重复登记）/ "pending"（结果未知）
//   - pending 重试前必须查重（verifyIngested：/recall 只读确认 [doubt] conflict
//     是否已摄入）——“客户端超时 ≠ 未写入”，先按去重键查重再判
//   - attempts 封顶（VERIFY_MAX_WRITE_ATTEMPTS，防半死服务窗口内滑动重试）
const verifyWriteLog = new Map();

/** 冲突登记前查重（P1-3 修复根因 3）：按去重键（归一化候选文本）直调 LMS
 * POST /recall（只读端点，零持久化）确认 [doubt] conflict 事件是否已摄入。
 * 返回 true=已摄入（服务端已有该冲突登记，不再写）/ false=未摄入 /
 * null=不可考（查重端点失败/超时 → 按“未知结果”处理：不重放不登记）。
 * LMS /feed 不返回条目 id（FeedResponse 仅 status/turn_count 等，硬约束禁改
 * LMS core）→ “按 id 查重”落地为“按去重键查重”：写入文本的归一化内容与
 * 已入库 [doubt] 事件内容做共享片段匹配（≥5 字即同冲突）。 */
export async function verifyIngested(cfg, key) {
  const results = await fetchLmsVerify(cfg, String(key || "").slice(0, 300));
  if (!Array.isArray(results)) return null; // 查重端点失败 → 未知
  for (const r of results) {
    const t = normalizeEntryKey(r && r.text);
    if (!t || !VERIFY_DOUBT_PREFIX_RE.test(t)) continue; // 只认 [doubt] 系统事件
    const content = t.replace(/^\s*\[doubt\]\s*(?:conflict|fok|lowconf|event)\s*:\s*/i, "");
    if (content && overlapMatch(content, key)) return true;
  }
  return false;
}

/** 写 [doubt] conflict 事件（POST {lmsUrl}/feed，doubt_ingest conflict 事件
 * → _find_overlapping_entry → mark_labile，Nader 2000 再巩固入口）。
 * 内容 = normalizeEntryKey(候选文本)（剥 ⚠️置信 标注——集成层读时注解，
 * episodic 存储无标注；带标注写会让 _find_overlapping_entry 包含匹配
 * 失败 → 证伪落空）。截 300 字（doubt_ingest 内容上限）。
 * fire-and-forget：调用方不 await（不阻塞注入热路径）。
 * P1-3 修复（根因 3，幂等竞态）：
 *   ① 写前先查重（verifyIngested）——已摄入 → 不写（防重复登记）；
 *   ② 写前乐观记窗口（pending）——超时/失败不丢窗口，下轮先查重再判；
 *   ③ done（200 确认）永久幂等；pending 窗口内重试封顶（attempts）；
 *   ④ 查重不可考 → 按“未知”处理：记 pending 不写（fail-closed，宁漏不重）。
 * 返回 {written, reason, id}：written=是否实际发出写入；reason ∈
 * written | dedup-done | dedup-ingested | pending-inconclusive |
 * write-failed | write-timeout | write-network-error；id=服务端确认标记
 * （LMS /feed 无条目 id，取 turn_count/status 作 ack 标记，无可为 null）。 */
export async function writeDoubtConflict(cfg, candidateText) {
  const key = normalizeEntryKey(candidateText);
  const now = Date.now();
  const entry = verifyWriteLog.get(key);
  // 已确认写入（服务端 200）→ 永久幂等：同冲突不重复登记（防 rebuttal 放大）
  if (entry && entry.state === "done") {
    logVerify("WRITE-DEDUP", { key, since_ms: now - entry.ts, reason: "already-registered" });
    return { written: false, reason: "dedup-done" };
  }
  // 窗口内 pending（上次写入结果未知）→ 先查重再判“未写入”
  if (entry && entry.state === "pending" && now - entry.ts < VERIFY_WRITE_DEDUP_MS) {
    if (entry.attempts >= VERIFY_MAX_WRITE_ATTEMPTS) {
      logVerify("WRITE-DEDUP", { key, since_ms: now - entry.ts, reason: "attempts-capped" });
      return { written: false, reason: "dedup-pending-capped" };
    }
    const ingested = await verifyIngested(cfg, key);
    if (ingested === true) {
      verifyWriteLog.set(key, { ts: now, state: "done" });
      logVerify("WRITE-DEDUP", { key, reason: "ingested-confirmed" });
      return { written: false, reason: "dedup-ingested" };
    }
    if (ingested === null) {
      logVerify("WRITE-DEDUP", { key, reason: "recheck-inconclusive" });
      return { written: false, reason: "pending-inconclusive" };
    }
    // ingested === false：上次确实未写入 → 允许窗口内重试（attempts 封顶防放大）
  } else {
    // 新窗口 / 窗口过期：冲突登记前先查重（防重复登记）
    const ingested = await verifyIngested(cfg, key);
    if (ingested === true) {
      verifyWriteLog.set(key, { ts: now, state: "done" });
      logVerify("WRITE-DEDUP", { key, reason: "ingested-confirmed" });
      return { written: false, reason: "dedup-ingested" };
    }
    if (ingested === null) {
      verifyWriteLog.set(key, { ts: now, state: "pending", attempts: 1 });
      logVerify("WRITE-PENDING", { key, reason: "recheck-inconclusive" });
      return { written: false, reason: "pending-inconclusive" };
    }
  }
  // 写尝试（乐观记窗口：写前先记 pending——超时也不丢窗口，下轮查重不重放）
  const attempts = (entry && entry.state === "pending" ? entry.attempts : 0) + 1;
  verifyWriteLog.set(key, { ts: now, state: "pending", attempts });
  const url = `${cfg.lmsUrl}/feed`;
  // P1 修复：超时可配（cfg.verifyTimeoutMs，测试加速用；缺省走模块常量）
  const timeoutMs = Number.isFinite(cfg && cfg.verifyTimeoutMs) && cfg.verifyTimeoutMs > 0
    ? cfg.verifyTimeoutMs : VERIFY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `[doubt] conflict: ${key.slice(0, 300)}`,
        session_id: cfg.landscapeSid || LANDSCAPE_SID,
        source: "glue-memory-injector",
        sender: "p1-3-verify",
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logMiss(`verify-write-non-2xx status=${resp.status} url=${url}`);
      return { written: false, reason: "write-failed", status: resp.status };
    }
    // 服务端确认（200）：记录 ack 标记（FeedResponse 无条目 id，取 turn_count/status）
    let ackId = null;
    try {
      const data = await resp.json();
      if (data && typeof data.turn_count === "number") ackId = data.turn_count;
      else if (data && typeof data.status === "string") ackId = data.status;
    } catch { /* 响应体非 JSON 也可确认（HTTP 200 即服务端已摄入） */ }
    verifyWriteLog.set(key, { ts: now, state: "done", id: ackId });
    return { written: true, reason: "written", id: ackId };
  } catch (err) {
    const why = err && err.name === "AbortError" ? "timeout" : "network-error";
    logMiss(`verify-write-${why} url=${url}`);
    // 超时/网络错误 = 结果未知（服务端可能已摄入）→ pending 保留 → 下轮查重
    return { written: false, reason: `write-${why}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 注入时验证链主流程（CoVe 轻量：草稿→独立验证→修正）。
 * 返回 verifyByText map：normalizeEntryKey(候选) → {verdict, reason, highTrust}
 * （仅 conflict-确认 入 map——topic 只验不标；无高 stakes / 无确认 → null）。
 * 草稿 = 冲突/敏感声明（VERIFY-TRIGGER 日志含输入）；独立验证 = V1(H 复现)
 * + V2(E 复现) 并行（防伪独立四条保证见段注释）；修正 = 确认 → 注入面标注
 * [doubt] conflict（buildContextText 消费）+ 写 [doubt] conflict → /feed。 */
export async function runVerifyChain(cfg, userQuery, results) {
  const stakes = detectHighStakes(results, process.env);
  if (stakes.length === 0) return null; // 零开销：无 HTTP、无日志
  const chains = stakes.slice(0, VERIFY_MAX_CHAINS);
  const out = {};
  // 草稿（Draft）：声明 + provenance（输入入日志）
  for (const s of chains) {
    logVerify("TRIGGER", {
      reason: s.reason,
      query: userQuery,
      candidate: s.candidate && s.candidate.text,
      highTrust: s.highTrustMatch ? s.highTrustMatch.text : "-",
    });
  }
  // 同 query 批次复用（双方向冲突对 E↔H 时，H-query/E-query 各只取一次独立
  // 批次——仍是草稿批次之外的独立采样，防伪独立不受影响；省冗余 HTTP）
  const memo = new Map();
  const verifyFetch = (q) => {
    if (memo.has(q)) return memo.get(q);
    const p = fetchLmsVerify(cfg, q);
    memo.set(q, p);
    return p;
  };
  // 独立验证（Independent）：全部链的 V1/V2 并行（互不等待，各 4s 超时）
  const pairs = await Promise.all(chains.map((s) => Promise.all([
    s.highTrustMatch
      ? verifyFetch(normalizeEntryKey(s.highTrustMatch.text))
      : Promise.resolve(null),
    verifyFetch(normalizeEntryKey(s.candidate.text)),
  ])));
  for (let i = 0; i < chains.length; i += 1) {
    const s = chains[i];
    const [v1, v2] = pairs[i];
    const hText = s.highTrustMatch ? normalizeEntryKey(s.highTrustMatch.text) : null;
    const cText = normalizeEntryKey(s.candidate.text);
    const hMatch = hText && v1
      ? v1.find((r) => r.text && overlapMatch(hText, r.text)) : null;
    const eMatch = v2
      ? v2.find((r) => r.text && overlapMatch(cText, r.text)) : null;
    // H 复现要求 doubt_verdict !== true（LMS conformal 分位已标怀疑的 H，
    // 不足以作为"高信任参照"）；E 复现不要求（E 被怀疑与冲突叙事自洽）
    const hRepro = hText !== null && !!hMatch && hMatch.doubtVerdict !== true;
    const eRepro = !!eMatch;
    logVerify("INDEP", {
      source: "lms-direct-recall",
      batchV1: v1 ? v1.length : -1,
      batchV2: v2 ? v2.length : -1,
      hRepro,
      eRepro,
      hCons: hMatch && hMatch.consistency !== null
        ? hMatch.consistency.toFixed(2) : "-",
      eCons: eMatch && eMatch.consistency !== null
        ? eMatch.consistency.toFixed(2) : "-",
      queryV1: hText || "-",
      queryV2: cText,
    });
    if (s.reason === "conflict") {
      // P1 修复（根因 2）：hRepro&&eRepro 只证“双方存在”，不证“矛盾”——
      // 命中后必须追加矛盾判定（方向性相反/数值差异超阈值/否定词极性翻转，
      // 三选一）才登记冲突（四妹 §二-2）。“双方存在”只是前提不是结论。
      const contradiction = s.highTrustMatch
        ? isContradictionPair(s.candidate.text, s.highTrustMatch.text)
        : false;
      const confirmed = hRepro && eRepro && contradiction;
      logVerify("RESULT", {
        verdict: confirmed ? "confirmed" : "not-confirmed",
        reason: "conflict",
        contradiction,
        candidate: s.candidate.text,
        highTrust: hText,
      });
      if (confirmed) {
        out[normalizeEntryKey(s.candidate.text)] = {
          verdict: "confirmed", reason: "conflict", highTrust: hText,
        };
        // 修正：写 [doubt] conflict → /feed（fire-and-forget：不阻塞注入热
        // 路径；结果入 VERIFY-WRITE 日志，written/reason/id 可查——P1 修复
        // 根因 3：写前查重 + 乐观窗口，超时≠未写入）
        writeDoubtConflict(cfg, s.candidate.text)
          .then((res) => {
            // 灰度观测（重审建议落地，2026-08-16）：写侧 dedup 分桶
            // written/dedup/rejected 三桶可机器统计（grep 'VERIFY-WRITE' |
            // grep -o 'bucket=[a-z]*' | sort | uniq -c）；rejected = 写失败/
            // 超时/查重不可考跳过（未写出）。阈值预案：dedup 异常 → 回滚。
            const reason = res && res.reason ? res.reason : "unknown";
            const bucket = reason === "written" ? "written"
              : reason.startsWith("dedup") ? "dedup"
              : "rejected";
            logVerify("WRITE", {
              endpoint: "/feed", kind: "conflict",
              ok: Boolean(res && res.written),
              reason,
              bucket,
              id: res && res.id !== undefined && res.id !== null ? res.id : "-",
              candidate: s.candidate.text,
            });
          })
          .catch(() => logVerify("WRITE", {
            endpoint: "/feed", kind: "conflict", ok: false,
            reason: "unexpected-error", bucket: "rejected",
            candidate: s.candidate.text,
          }));
      }
    } else {
      // 敏感话题：验证候选可复现性；topic 非 conflict，不写 labile、不标注
      logVerify("RESULT", {
        verdict: eRepro ? "ok" : "not-confirmed",
        reason: "topic",
        candidate: s.candidate.text,
        eRepro,
        eCons: eMatch && eMatch.consistency !== null
          ? eMatch.consistency.toFixed(2) : "-",
      });
    }
  }
  return Object.keys(out).length > 0 ? out : null;
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
 * @param {object|null} verifyByText 阶段 2 步骤 4（P1-3）：注入时验证链产物
 *   map（normalizeEntryKey(候选) → {verdict, reason, highTrust}，runVerifyChain
 *   返回）。conflict-确认 条目在注入面标注 [doubt] conflict（可见怀疑，与 P1-2
 *   [doubt] lowconf 正交——冲突标注是验证结果，非低信任惩罚）。缺省 null。
 * @param {object|null} hygiene 注入卫生四刀（2026-09-21；resolveInjectHygiene 产物）。
 *   缺省 null = 关闭四刀（退旧行为——直接单测/向后兼容路径零变化）。fail-open：
 *   四刀任何一步异常都被 try/catch 兜住，退旧行为继续拼注入，绝不抛。
 */
export function buildContextText(data, query, maxChars, skipSelfRef = false, reactData = null, activatedThought = null, consistencyByText = null, verifyByText = null, hygiene = null) {
  if (!data || typeof data !== "object") {
    logMiss("recall-invalid-response"); // P0-1：/recall 响应结构异常
    return null;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    logMiss("recall-no-results"); // P0-1：/recall 无命中
    return null;
  }

  // ④ 焦点记忆：3-5 条（Cowan 4±1），六层衔接加权（R4，定稿 v2 §四-3）+
  //    P1-2 score 公式（§五-1，阶段 2 步骤 3）：
  //      score = relevance × (α·trust + β·consistency) × landscapeAct
  //    相关性 = scores.total（glue 协同分）；trust = ⚠️置信 标注
  //    （parseConfidenceTag，无标注默认 1.0——integration_service 只注
  //    confidence<0.5 条目，故 trust 分布天然双峰：{1.0 无标注} ∪ {<0.5 标注}）；
  //    consistency = 窄路径 LMS recall-time 一致性（consistencyByText，按归一化
  //    text join）或静态默认 0.5（中性，无抽样印证信息不惩罚不奖励）；
  //    景观激活 = scores.lms_activation（R4 乘数保留）。
  //    R1（§五-3）：trust < SCORE_TRUST_THRESHOLD(0.3) → 降权 ×0.3 或
  //    [doubt] lowconf 标注**二选一**（禁双重惩罚；默认降权，
  //    SCORE_DOUBT_MODE=annotate 切换）——不是接口摆设，降权可见于排序、
  //    标注可见于注入文本。
  //    R8（§五-2）：trust 归一化核验先行——TRUST-DIST 日志（批内分布
  //    min/max/mean/p10/p50/p90，定阈值前核验尺度漂移；阈值参数化可调）。
  //    精确去重（同文不重复注入）。
  //    P2-6（审计 2026-08-16 已知行为记录）：缺分字段条目用 1.0 中性值
  //    （fail-open 不误杀）→ 无分条目可反超有分条目（权 1.00 排首）；glue
  //    实测恒带 scores，风险低，此处记录备查。
  const sp = resolveScoreParams(process.env);
  const items = [];
  const seenTexts = new Set();
  const trustTagged = [];
  let untaggedCount = 0;
  for (const it of results) {
    const text = typeof it?.text === "string" ? it.text.trim().replace(/\s+/g, " ") : "";
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    const relevance = typeof it?.scores?.total === "number" ? it.scores.total : 1.0;
    const trustTag = parseConfidenceTag(text);
    const trust = trustTag ?? 1.0;
    const landscapeAct = typeof it?.scores?.lms_activation === "number"
      ? it.scores.lms_activation : 1.0;
    // consistency：窄路径 map（按归一化 text join，P1-2）优先；否则静态默认
    const consEntry = consistencyByText && typeof consistencyByText === "object"
      ? consistencyByText[normalizeEntryKey(text)] : null;
    const consistency = consEntry && typeof consEntry.consistency === "number"
      ? consEntry.consistency : CONSISTENCY_STATIC_DEFAULT;
    // score 公式（P1-2）+ R4 景观激活乘数保留
    const baseWeight = computeFocusScore(
      relevance, trust, consistency, sp.scoreAlpha, sp.scoreBeta) * landscapeAct;
    const policy = applyLowTrustPolicy(baseWeight, trust, sp);
    if (trustTag !== null) {
      trustTagged.push(trustTag);
    } else {
      untaggedCount += 1;
    }
    if (trust < sp.trustThreshold) {
      // R1 生效观测（灵魂指标：二选一生效不是接口摆设）
      logScoreDoubt(sp.doubtMode, trust, baseWeight, policy.score, policy.annotated, text);
    }
    items.push({
      text,
      // key 在截断前算好（cut c 会截 text，但 consistency/verify join 依赖完整键）
      key: normalizeEntryKey(text),
      tsMs: parseEntryTimestamp(it),
      origin: typeof it?.origin === "string" && it.origin ? it.origin : "",
      score: typeof it?.scores?.total === "number" ? it.scores.total : null,
      weight: policy.score,
      lowTrustAnnotated: policy.annotated,
    });
  }
  // R8：批内 trust 分布核验日志（仅真实标注值；无标注计数另记）
  if (trustTagged.length > 0) {
    logTrustDist(trustDistributionStats(trustTagged), untaggedCount);
  }
  // 六层衔接加权（R4+P1-2）：score 降序取舍（滤伪相关）；低信任条目经降权沉底
  // /标注可见（审计 D 同法：高相关低信任沉底）
  // 自指回路止血（2026-09-16，四妹定位）: weight<=0 = 打分器已判无价值（如 [回魂]/self_ref
  // 被压到 0 权），但它仍按"条数"占位 ⇒ 先剔，再按条数截断（判决与执行对齐）。
  let usable = items.filter((it) => Number(it.weight) > 0);
  // ── 注入瘦身四刀（2026-09-21，hygiene 缺省 null = 关闭，退旧行为）──
  // 顺序：a 剔机器自述 → c 真记忆去冗 → b 同段去重 → d 陈旧降权。
  //   - a 先剔掉机器产物（它们常是"包含其他条目文本"的注入留存，先剔防污染
  //     b 的去重判据）；
  //   - c 在去重前截断，让去重判据工作在"实际要注入的文本"上（长文截尾后
  //     更易暴露同源重复）；
  //   - d 最后生效于 weight（排序 + 显示权值都能看到时代价）。
  //   fail-open：整段 try/catch，任何异常 → hygiene 视同 null（不改 usable）。
  if (hygiene && typeof hygiene === "object") {
    try {
      const st = { machine: 0, dup: 0, trunc: 0, recency: 0, kept: 0, chars: 0 };
      if (hygiene.stripMachineNarration) {
        const before = usable.length;
        usable = usable.filter((it) => !isMachineNarration(it.text));
        st.machine = before - usable.length;
      }
      if (hygiene.entryTruncate) {
        for (const it of usable) {
          const t = truncateEntryText(it.text, hygiene.entryMaxChars, hygiene.entryTruncateTailChars);
          if (t !== it.text) { it.text = t; st.trunc += 1; }
        }
      }
      if (hygiene.dedupeNearDuplicates && usable.length > 1) {
        const before = usable.length;
        usable = dedupeNearDuplicateItems(usable, hygiene.dedupeSimilarity, hygiene.dedupeMinSharedChars);
        st.dup = before - usable.length;
      }
      if (hygiene.recencyWeight) {
        const now = Date.now();
        for (const it of usable) {
          const f = recencyFactor(it.tsMs, now, hygiene.recencyHalfLifeDays, hygiene.recencyFloor);
          if (f < 1) { it.weight = it.weight * f; st.recency += 1; }
        }
      }
      st.kept = usable.length;
      st.chars = usable.reduce((s, it) => s + it.text.length, 0);
      logHygiene(st);
    } catch {
      // 四刀任一步异常 → 退旧行为（usable 保持异常前状态；不抛、不阻断注入）
    }
  }
  usable.sort((a, b) => b.weight - a.weight);
  const picked = usable.slice(0, FOCUS_MAX_ITEMS);
  if (picked.length === 0) {
    logMiss("recall-no-usable-text"); // P0-1：命中条目均无可注入文本
    return null;
  }

  const lines = [`【系统注入 · 非用户消息】[记忆注入] 焦点记忆 ${picked.length} 条（按"${String(query).slice(0, 60)}"激活加权召回）：`];
  for (const [i, it] of picked.entries()) {
    // 来源 + 置信度标注 + 加权分（R4/P1-2 可观测）：[origin·分total·权score]；
    // 无分时仅标来源；R1 annotate 模式追加 [doubt] lowconf（降权模式不标注——
    // 禁双重惩罚，降权已体现在权值）
    const meta = it.origin
      ? `[${it.origin}${it.score !== null ? `·分${it.score.toFixed(2)}` : ""}·权${it.weight.toFixed(2)}]`
      : "";
    // P1-3：注入时验证链产物（verifyByText，按归一化 text join）——
    // conflict-确认 条目追加 [doubt] conflict（可见怀疑：本条目与高信任记忆
    // 冲突且经独立验证确认；详情在 VERIFY-* 日志，provenance 可查）。
    // 与 [doubt] lowconf 正交：冲突标注是验证结果，非低信任惩罚（R1 二选一
    // 是 P1-2 的 trust 语义，本标注是 P1-3 的验证语义，互不替代）。
    const vEntry = verifyByText && typeof verifyByText === "object"
      ? verifyByText[it.key || normalizeEntryKey(it.text)] : null;
    const conflictTag = vEntry && vEntry.verdict === "confirmed"
      ? " [doubt] conflict" : "";
    lines.push(`${i + 1}. ${meta} ${it.text}${it.lowTrustAnnotated ? " [doubt] lowconf" : ""}${conflictTag}`);
  }

  // ⑤ 质疑层 + ⑥ 行动层（阶段 4：激活的 thought 才带行动意向；无则占位）
  const doubt = buildDoubtLayer(results, reactData);
  if (doubt) lines.push(doubt);
  // ⑥ 行动层（cut a）：行动层是思考链自产的"机器自述"（该做/想/愿），现场取证
  // 它直接进注入稀释真记忆 → 开 hygiene 时不注入（含占位行）。
  if (!(hygiene && typeof hygiene === "object" && hygiene.stripMachineNarration)) {
    const actionLine = buildActionLayer(activatedThought);
    lines.push(actionLine || "[行动] 无（暂无行动意向）");
  }

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
    let voices = Array.isArray(data.self_ref) ? data.self_ref.filter(v => typeof v === "string" && v.trim()) : [];
    // cut a+b：剔机器自述（"激活节点"清单等）+ 同指纹折叠（实测 4 条仅节点编号
    // 不同 → 折叠为 1 条，治"[记忆系统自述] 被重复 4 遍"）。
    if (hygiene && typeof hygiene === "object") {
      try {
        if (hygiene.stripMachineNarration) voices = voices.filter((v) => !isMachineNarration(v));
        if (hygiene.dedupeNearDuplicates) {
          const seen = new Set();
          voices = voices.filter((v) => {
            const fp = narrationFingerprint(v);
            if (seen.has(fp)) return false;
            seen.add(fp);
            return true;
          });
        }
      } catch { /* fail-open：退旧行为 */ }
    }
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
  // 注入瘦身四刀（2026-09-21）：从 pluginConfig/env 解析，默认全开。
  const hygiene = resolveInjectHygiene(process.env, pluginConfig);
  if (!cfg.enabled) {
    logMiss("plugin-disabled"); // P0-1
    return null;
  }
  logScoreParams(resolveScoreParams(process.env)); // P1-2 参数先落盘（每进程一次）
  logVerifyParams(); // P1-3 参数先落盘（每进程一次）
  // 召回L1-a（2026-08-11）：query 净化 —— 剥离 openclaw 元数据块/时间戳/
  // 子代理模板，取用户真实正文前 QUERY_MAX_CHARS 字；纯模板/心跳 → null 不注入；
  // 净化异常回落原逻辑（fail-open）。
  // 第六刀（2026-09-21，dandan 17:50「剥机器段对，但别把回魂一起剥掉」）：
  // 用带因版 extractQueryInfo —— 把两类 null 分开：
  //   ① machineOnly=true（唤醒轮：醒因原文 = 纯机器载荷被第五刀剥净）
  //        ⇒ soulOnlyWake 模式：soul（默认）= 只注【回魂】人可读段；off = 什么都不注；
  //           full = 全注（该轮不剥 query，退旧行为）。
  //   ② machineOnly=false（纯元数据/心跳/子代理模板/跨会话）⇒ 照旧不注入。
  const qi = extractQueryInfo(prompt, hygiene);
  let query = qi.query;
  const wakeMode = hygiene && hygiene.soulOnlyWake !== undefined ? hygiene.soulOnlyWake : "soul";
  if (!query && qi.machineOnly && wakeMode === "full") {
    // 全注回撤：唤醒轮不剥机器段（旧行为：醒因原文当 query，走完回魂+记忆块）
    query = extractQueryInfo(prompt, { ...hygiene, stripMachineQuery: false }).query;
  }
  if (!query) {
    if (qi.machineOnly && wakeMode === "soul") {
      // 唤醒轮：剥了召回输入（不拿系统词钓陈旧长文），但**回魂不能一起剥掉**。
      return await buildSoulOnlyWakeText(cfg, hygiene);
    }
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
    const soulText = buildSoulText(soulData, cfg.soulMaxChars, reactData, query, cfg, picked, landscapeData, hygiene);
    // P1-4（审计 2026-08-14）：注入预算余量保护。旧实现按 maxChars 顶格执行
    // （实测 798/800，余量 2 字——回魂段 301 必截、最近记忆必丢）。现在：
    //   ① 总量按 maxChars-COMPOSE_MARGIN=760 执行（40 字安全余量）；
    //   ② thought ≤60 字/条 + 去重 + 单条上限（回魂段内「最近」不再被挤掉）；
    //   ③ 回魂段保护优先级不变：[回魂] 永不先截（composeContext 先截记忆块）。
    const injectBudget = Math.max(200, cfg.maxChars - COMPOSE_MARGIN);
    // 记忆块预算 = 注入预算 - 回魂段 - "\n\n" 分隔符（与 composeContext 的
    // keep=soulText.length+2 对齐，避免 compose 二次截断吃掉尾部结构层）
    const memoryBudget = Math.max(200, injectBudget - (soulText ? soulText.length + 2 : 0));
    // P1-2 低信任窄路径（定稿 v2 §五-4）：批内存在 trust<阈值 条目 → 直调 LMS
    // POST /recall（只读：count_reference=False、零持久化）取 recall-time
    // consistency（Koriat 自一致性 = SelfCheckGPT 工程同构）——常态（无低信任
    // 条目）零额外调用，consistency 全走静态默认 0.5。失败 fail-open → null。
    let consistencyByText = null;
    if (cfg.lmsRecallConsistencyEnabled && recallData && Array.isArray(recallData.results)) {
      const sp = resolveScoreParams(process.env);
      const lowTrustPresent = recallData.results.some((it) => {
        const t = parseConfidenceTag(it && it.text);
        return t !== null && t < sp.trustThreshold;
      });
      if (lowTrustPresent) {
        consistencyByText = await fetchLmsRecallConsistency(cfg, query) || null;
      }
    }
    // P1-3 注入时验证链（定稿 v2 §六，2026-08-16）：高 stakes（①注入内容与
    // 高信任记忆冲突 ②STAKE_TOPICS 敏感话题）→ 草稿→独立验证→修正。
    // 产物 map 透传 buildContextText（conflict-确认 → 注入面 [doubt] conflict
    // 标注）+ [doubt] conflict 写 /feed（fire-and-forget → doubt_ingest
    // conflict 事件 → mark_labile，Nader 2000 再巩固入口）。
    // 零开销契约：无高 stakes → 零 HTTP、零日志、注入面零改动。
    let verifyByText = null;
    if (cfg.verifyChainEnabled && recallData && Array.isArray(recallData.results)) {
      verifyByText = await runVerifyChain(cfg, query, recallData.results);
    }
    // reactData 透传给 buildContextText：质疑层需要全局 precision 信号；
    // consistencyByText：P1-2 consistency 窄路径数据（缺省 null → 静态默认）；
    // verifyByText：P1-3 验证链产物（缺省 null → 无冲突标注）
    const memoryText = buildContextText(recallData, query, memoryBudget, Boolean(soulText), reactData, pickedThought, consistencyByText, verifyByText, hygiene);

    return composeContext(soulText, memoryText, injectBudget);
  } catch (err) {
    logMiss(`unexpected ${err instanceof Error ? err.message : String(err)}`); // P0-1：兜底
    return null;
  } finally {
    inflight = false;
  }
}
