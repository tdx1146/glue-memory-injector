// 只读纯函数验证（零网络、零写盘）：证明正路 payload 现在带 source_kind
import { resolveStoreConfig, buildStorePayload, extractTurnFromMessages } from "./store-turn.js";
const cfg = resolveStoreConfig({ storeTurn: { enabled: true } }, {});
console.log("sourceKindEnabled =", cfg.sourceKindEnabled);
const humanMsgs = [
  { role: "user", content: "另外我问一下，我们哪些什么门禁啊，胶水层啊，总线啊，都在新的V2版本中吧？" },
  { role: "assistant", content: "## 你这三个问题，我用事实答" },
];
const p1 = buildStorePayload(extractTurnFromMessages(humanMsgs), cfg, "main");
console.log("① 人回合   source_kind =", JSON.stringify(p1.source_kind), "| keys =", Object.keys(p1).join(","));
const bMsgs = [
  { role: "user", content: "[Inter-session message] sourceSession=agent:main:subagent:x sourceChannel=webchat sourceTool=subagent\n报告正文" },
  { role: "assistant", content: "主代理采纳段" },
];
console.log("② 模式B    source_kind =", JSON.stringify(buildStorePayload(extractTurnFromMessages(bMsgs), cfg, "main").source_kind));
const wMsgs = [
  { role: "user", content: "[Sat 2026-09-19 18:36 GMT+8] 📬【信箱新消息】见 /tmp/mailbox-inbox.txt（mailbox-poll 自动唤醒）" },
  { role: "assistant", content: "回信" },
];
console.log("③ 唤醒信   source_kind =", JSON.stringify(buildStorePayload(extractTurnFromMessages(wMsgs), cfg, "main").source_kind));
const off = resolveStoreConfig({ storeTurn: { enabled: true, sourceKindEnabled: false } }, {});
console.log("④ 开关关   keys =", Object.keys(buildStorePayload(extractTurnFromMessages(humanMsgs), off, "main")).join(","));
