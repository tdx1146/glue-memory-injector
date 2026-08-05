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

const HOOK_TIMEOUT_MS = 15000; // 与 runner 默认 before_prompt_build 预算一致

export default definePluginEntry({
  id: "glue-memory-injector",
  name: "Glue Memory Injector",
  description:
    "每轮对话前经胶水层 /recall 注入记忆上下文（fail-open；限流 ≥2s；≤1500 字）",
  register(api) {
    api.on(
      "before_prompt_build",
      async (event) => {
        try {
          const prompt = typeof event?.prompt === "string" ? event.prompt : "";
          const text = await buildMemoryContext(
            prompt,
            event?.context?.pluginConfig,
          );
          if (!text) return; // 无记忆/限流/故障 → 不注入
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
