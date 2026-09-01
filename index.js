// index.js — OpenClaw 插件入口：glue-memory-injector
//
// ⚠️【双机制共存警告 2026-09-01 dandan 指令——后来者先读这段再改】：
//   LMS 记忆注入有两套独立插件跑在不同运行时，**本插件 ≠ dsh-lms-memory**：
//   ① 本插件 = **OpenClaw gateway 运行时**（~/.openclaw/plugins/），
//      before_prompt_build 钩子 → 返回 prependContext 拼进 prompt →
//      **GUI 不显示**（只有模型看到）。改动需重启 OpenClaw gateway。
//   ② dsh-lms-memory = **DSH web 运行时**（agentos-v2/dsh-plugins/lms-memory +
//      ~/.dsh/profiles/web/node_modules/dsh-lms-memory/），agent/pre-step 钩子
//      → append 可见 user 消息 → **GUI 会话可见**（dandan 在 DSH 里看到的注入）。
//   判断改的是哪个：看目录（本插件在 .openclaw/plugins/；dsh-lms-memory 在
//      agentos-v2/dsh-plugins/ 或 .dsh/profiles/web/node_modules/）。
//   不要跨目录重复实现同一功能；改前先 grep 对方目录确认没有同款逻辑。
//
// Hook：before_prompt_build（每轮模型调用前）
//   - 返回 { prependContext: string } → OpenClaw 把该文本拼到用户消息之前
//     （prependContext 契约类型为 string，见 plugin-sdk hook-before-agent-start.types.d.ts）
//   - 任何异常返回 undefined（fail-open），绝不阻塞主循环
//
// 逻辑在 memory-recall.js（纯模块，可单测）；本文件只做 SDK 接线。

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMemoryContext } from "./memory-recall.js";
import { handleAgentEnd } from "./store-turn.js";
import { appendFileSync } from "node:fs";

const HOOK_TIMEOUT_MS = 15000; // 与 runner 默认 before_prompt_build 预算一致
// 阶段2（S2-1）：agent_end 观察型钩子预算。30s 是 runner 默认上限
// （DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK={agent_end:3e4}，源码实证）；
// 写侧自身 AbortSignal 12s（M-3）远小于此，钩子绝不拖慢主循环。
const AGENT_END_TIMEOUT_MS = 30000;

export default definePluginEntry({
  id: "glue-memory-injector",
  name: "Glue Memory Injector",
  description:
    "每轮对话前经胶水层 /recall 注入记忆上下文（fail-open；限流 ≥2s；≤1500 字）",
  register(api) {
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        try {
          const prompt = typeof event?.prompt === "string" ? event.prompt : "";
          // ★ 2026-08-08 根治修复：心跳轮不注入。
          // 心跳 poll 每 30 分钟触发一次模型调用，本插件在 before_prompt_build
          // 同时注入【回魂】+记忆上下文，同一毫秒碰撞会把心跳 run 弄坏
          // （2026-08-07 曾出现 openclaw:prompt-error），会话文件带伤 →
          // 下一次用户消息派发触发网关角色顺序校验失败 → 自动重置会话。
          // 双重判据：① ctx.trigger === "heartbeat"（run 级信号）
          //           ② prompt 文本含 heartbeat poll（兜底）。
          const isHeartbeat = ctx?.trigger === "heartbeat" || /heartbeat\s*poll/i.test(prompt);
          // ★ 2026-08-11 召回L1-b：子代理轮不注入记忆。
          // 子代理的"用户消息"是模板（[Subagent Context]…），真实任务在系统提示
          // （hook 拿不到）；每轮注入 1500 字纯浪费且污染存储 —— 模板记忆被模板
          // query 反复召回，形成自增强污染环（见《记忆召回相关性-调研与方案》§2.5）。
          // 判据：ctx.sessionKey 含 subagent 段（agent:…:subagent:… 或 subagent: 前缀）。
          const isSubagentRound =
            typeof ctx?.sessionKey === "string" &&
            /(^|:)subagent[:.]/i.test(ctx.sessionKey);
          const _dbg = prompt.slice(0, 100).replace(/\n/g, " ");
          try {
            appendFileSync("/tmp/glue-hook-debug.log", `[${new Date().toISOString()}] trigger=${String(ctx?.trigger)} isHb=${isHeartbeat} isSub=${isSubagentRound} sessionKey=${String(ctx?.sessionKey)} prompt=${JSON.stringify(_dbg)}\n`);
          } catch {}
          if (isHeartbeat || isSubagentRound) {
            if (isSubagentRound && !isHeartbeat) {
              try {
                appendFileSync("/tmp/glue-hook-debug.log", `[${new Date().toISOString()}] SUBAGENT-SKIP sessionKey=${String(ctx?.sessionKey)}\n`);
              } catch {}
            }
            return;
          }
          const text = await buildMemoryContext(
            prompt,
            event?.context?.pluginConfig,
          );
          if (!text) {
            // P0-1 止血：消除静默失败 —— buildMemoryContext 返回 null 时记 MISS。
            // 具体原因（超时/限流/空结果/网络错误）已在 memory-recall.js 内按路径写明细。
            try {
              appendFileSync("/tmp/glue-hook-debug.log", `[${new Date().toISOString()}] MISS reason=no-injectable-context（明细见同文件内 MISS 记录）\n`);
            } catch {}
            return; // 无记忆/限流/故障 → 不注入
          }
          try {
            appendFileSync("/tmp/glue-hook-debug.log", `[${new Date().toISOString()}] INJECTED len=${text.length}\n`);
          } catch {}
          return { prependContext: text };
        } catch (err) {
          api.logger?.warn?.(
            `[glue-memory-injector] before_prompt_build fail-open: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return; // fail-open
        }
      },
      { timeoutMs: HOOK_TIMEOUT_MS },
    );

    // 阶段2（S2-1）：agent_end 写侧（观察型，fire-and-forget，默认关）。
    //   - 逻辑全在 store-turn.js（纯模块可单测）；本文件只做 SDK 接线。
    //   - 默认关：config.storeTurn.enabled=false → handleAgentEnd 首行 return
    //     （写侧零副作用；钩子已注册且被授予会话读取权限——碰 openclaw 运行时，
    //     G-5 表述）。
    //   - fail-open 三重：提取异常→skip；网络异常/超时→记日志返回；
    //     钩子抛错→runner catch（30s 预算 + fire-and-forget 机制实证）。
    //   - 需要 openclaw.json 配 plugins.entries.glue-memory-injector.hooks
    //     .allowConversationAccess=true，否则非 bundled 插件该钩子被加载器丢弃
    //     （loader 源码实证）——见 S2-2。
    api.on(
      "agent_end",
      (event, ctx) => handleAgentEnd(event, ctx, api),
      { timeoutMs: AGENT_END_TIMEOUT_MS },
    );
  },
});
