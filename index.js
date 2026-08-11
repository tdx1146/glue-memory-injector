// index.js — OpenClaw 插件入口：glue-memory-injector
//
// Hook：before_prompt_build（每轮模型调用前）
//   - 返回 { prependContext: string } → OpenClaw 把该文本拼到用户消息之前
//     （prependContext 契约类型为 string，见 plugin-sdk hook-before-agent-start.types.d.ts）
//   - 任何异常返回 undefined（fail-open），绝不阻塞主循环
//
// 逻辑在 memory-recall.js（纯模块，可单测）；本文件只做 SDK 接线。

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMemoryContext } from "./memory-recall.js";
import { appendFileSync } from "node:fs";

const HOOK_TIMEOUT_MS = 15000; // 与 runner 默认 before_prompt_build 预算一致

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
          const _dbg = prompt.slice(0, 100).replace(/\n/g, " ");
          try {
            appendFileSync("/tmp/glue-hook-debug.log", `[${new Date().toISOString()}] trigger=${String(ctx?.trigger)} isHb=${isHeartbeat} prompt=${JSON.stringify(_dbg)}\n`);
          } catch {}
          if (isHeartbeat) return;
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
  },
});
