// 只读纯函数验证（零网络、零写盘、未向 /store 发任何请求）：证明正路 payload 带 source_kind
import { resolveStoreConfig, buildStorePayload, extractTurnFromMessages } from "./store-turn.js";
const mk = (cfg, u, a) =>
  buildStorePayload(
    extractTurnFromMessages([{ role: "user", content: u }, { role: "assistant", content: a }]),
    cfg,
    "main",
  );
const cfg = resolveStoreConfig({ storeTurn: { enabled: true } }, {});
console.log("sourceKindEnabled =", cfg.sourceKindEnabled);
const p1 = mk(cfg, "另外我问一下，我们哪些什么门禁啊，胶水层啊，总线啊，都在新的V2版本中吧？", "## 你这三个问题…");
console.log("① 人类原话        source_kind =", JSON.stringify(p1.source_kind), "| keys =", Object.keys(p1).join(","));
console.log("② 模式B(inter)    source_kind =", JSON.stringify(mk(cfg, "[Inter-session message] sourceSession=agent:main:subagent:x sourceTool=subagent\n报告正文", "采纳段").source_kind));
console.log("③ 信箱唤醒信      source_kind =", JSON.stringify(mk(cfg, "[Sat 2026-09-19 18:36 GMT+8] 📬【信箱新消息】见 /tmp/mailbox-inbox.txt（mailbox-poll 自动唤醒）", "回信").source_kind));
console.log("④ think_loop自造  source_kind =", JSON.stringify(mk(cfg, "[Sat 2026-09-19 18:40 GMT+8] 你是思考链的【后台思考者】（隔离子代理…）", "产出").source_kind));
const off = resolveStoreConfig({ storeTurn: { enabled: true, sourceKindEnabled: false } }, {});
const pOff = mk(off, "人话", "答");
console.log("⑤ 开关关 keys =", Object.keys(pOff).join(","), "| 含source_kind?", "source_kind" in pOff);
const envOff = resolveStoreConfig({}, { GLUE_STORE_SOURCE_KIND_ENABLED: "0" });
console.log("⑥ env=0 兜底关 sourceKindEnabled =", envOff.sourceKindEnabled);
