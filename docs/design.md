# 编辑器位置上下文（Editor Context）调研与设计

> 调研：2026-10-14 · 工作区 `/data/project/dsh-plugin`
> 目标：你在 Cursor 里处理某一行/选区时，DSH（agent）能知道是**哪个文件的哪一段**，并能**翻阅到那个位置**。
> 前提：DSH 跑在**浏览器 web profile**；Cursor 是你的编辑器（不是 agent）。

> **实现状态（里程碑 1 已完成）**：Cursor 扩展 + 状态文件 + `UserPromptSubmit` hook 已实现并验证，
> 代码在 [`editor-context/`](../editor-context/)，产物 `editor-context-0.1.0.vsix`（14 KB）。
> 18 个用例全绿（10 纯逻辑 + 8 hook 端到端）；真实链路已用**编译产物**跑通：
> `out/state.js` 写状态 → hook 输出 `hookEventName: "UserPromptSubmit"` 的 JSON → 位置未变时 0 字节。
> **MCP 面（§3 的 face 1）尚未实现**，见「待决」。

---

## 0. 一句话结论

Claude Code 的这个能力 = **IDE 端采集 + agent 端注入**，其中「选区共享」走的是**上下文注入**、不是工具调用。
对 DSH 来说：**MCP 能把「主动查」和「跳转」做成通用件，但「每轮自动知道」必须靠 hooks**——两者共用一个采集源。

---

## 1. 对标：Claude Code 到底怎么做的（已核实）

| 能力 | 机制 | 出处 |
|---|---|---|
| 每轮自动共享 | CLI 把「当前选区 + 活动文件路径」作为**上下文**注入，聊天显示 `⧉ Selected N lines from <file>` | [VS Code 文档](https://code.claude.com/docs/en/vs-code)、[JetBrains 文档](https://code.claude.com/docs/en/jetbrains) |
| 快捷键插入引用 | `Option+K` / `Alt+K` → `@file.ts#5-10`（JetBrains：`Ctrl+Alt+K` → `@src/auth.ts#L1-99`） | 同上 |
| 反向跳转 | IDE MCP server 的**内部 RPC**（开 diff、读选区、存文件）；对模型**不可见** | VS Code 文档「The built-in IDE MCP server」 |
| 暴露给模型的工具 | **只有 2 个**：`getDiagnostics`、`executeCode` | 同上 |
| 传输与鉴权 | 扩展起 WS server（随机端口）→ 写 `~/.claude/ide/<port>.lock`（0600，含 `authToken`）→ CLI 带 `X-Claude-Code-Ide-Authorization` 连上 | 同上 |

**关键结论：选区共享不是 MCP 工具，是 harness 侧的上下文注入。** MCP 是拉取式的，推不动 prompt。

---

## 2. 现成工具盘点（都查过，无一站式 DSH 版）

| 工具 | 形态 | 能做什么 | 为什么不能直接用 |
|---|---|---|---|
| [ctx-push / Context Push](https://github.com/lntvan166/ctx-push) | VS Code/Cursor 扩展，**MIT**，TS，55 文件（Open VSX `lntvan166.claude-context`，4.3k 下载） | 选中代码 → `Ctrl+Alt+C` → `@src/auth.ts:11-14`；有引用缓冲、历史、状态栏；并**完整复刻了 Claude Code 的 IDE bridge**（WS + `~/.claude/ide/<port>.lock` + `authToken` + subprotocol `mcp`），能直推 Claude Code 会话输入框 | ① 传输只认 Claude Code 的 `/ide` 发现协议；② **输出格式 `@path:11-14` 在 DSH 里解析不了**（见 §4） |
| [Pylon](https://github.com/toalba/Pylon) | VS Code/Cursor 扩展 + 本地 MCP server（Open VSX `rias.pylon-mcp`，2.1k） | `open_file`：**打开文件并跳到指定行 / 高亮区间**；另有 diagnostics / symbols / debug / terminal 工具；hub-satellite 支持多窗口 | 只解决「agent → IDE」这一向，**不暴露活动编辑器/选区** |
| [mcp-selection-bridge](https://github.com/auroraslot/mcp-selection-bridge) | JetBrains 插件 + MCP streamable-http（`127.0.0.1:63450`，一个工具 `get_idea_selection`） | 返回各项目窗口选中内容的**文件路径 + 行号范围 + 文本** | JetBrains 专用，Cursor 装不了。**但架构就是标准答案** |
| [juehang/vscode-mcp-server](https://github.com/juehang/vscode-mcp-server) | VS Code 扩展 + MCP streamable-http（391★） | file / edit / symbol / diagnostics / shell 工具 | 工具清单里**没有选区或活动编辑器** |
| DSH `dsh-tmux-context` | DSH 官方插件 | 每轮注入「我在哪个 tmux session/window/pane」；**仅变化时注入**、来源可标注、失败即 no-op、可选挂载 | 不是 IDE 版；但这是要照抄的**注入范式** |

**没有任何现成插件能让 DSH 知道你在 Cursor 里看哪一行。**

---

## 3. 架构：一个采集源 + 两个面

```
Cursor / VS Code 扩展（一份代码，VS Code / Cursor / Windsurf 通用）
├─ capture   onDidChangeTextEditorSelection / onDidChangeActiveTextEditor
│              └─ 单一事实源（内存 + 原子写的状态文件；含 workspaceFolders）
├─ face 1    MCP server（streamable-http，127.0.0.1）
│              get_selection / get_active_file / list_windows / open_at_range
└─ face 2    状态文件 ~/.editor-context/state.json   ← 供 hooks 读取（推送面）
    face 3    附赠：UserPromptSubmit hook 脚本 + DSH / Claude Code 配置片段
```

| 面 | 覆盖 | Claude Code | Cursor | Codex / Kimi | **DSH** |
|---|---|---|---|---|---|
| MCP（拉取 + 跳转） | 「我在看什么」按需查、「跳到某行」 | ✅ | ✅ | ✅ | ✅ `dsh-mcp-client`：`transport: streamable-http` + `url` + `headers`，工具名 `mcp__<serverName>__<tool>` |
| hooks（每轮自动带） | 「不用问就已经知道」 | ✅ | ⚠️ 映射到 `beforeSubmitPrompt`，**只支持 `{continue, user_message}`，插不了上下文** | ✅ Codex 有自己的 hook 方言（DSH 侧对应 `dsh-hooks-codex`）；Kimi 未核实 | ✅ `dsh-hooks-claude-code` 的 `UserPromptSubmit` 支持 JSON `additionalContext` |

**DSH 侧两条路都是通的**，这是本方案成立的关键。

### 3.1 hooks 面的具体挂法（DSH）

`dsh-hooks-claude-code` 已装（`@deepseek-ai/dsh-hooks-claude-code@0.2.1-alpha.2`，**未废弃**：npm 无 deprecated 标记，最新 alpha 发布于 2026-10-09，并与 `@deepseek-ai/dsh-hooks-codex` 共用独立发布的 `@deepseek-ai/dsh-hook-protocol`）。你在 `~/.dsh/hooks/hooks.json` 里已有 `PreToolUse` / `PostToolUse`。新增一条：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
        "command": "python3 \"$HOME/.dsh/hooks/editor_context.py\"",
        "timeout": 5 } ] }
    ]
  }
}
```

**四条硬契约**（违反任一条会静默失效，实测自 `dsh-hook-protocol/lib/types/types.d.ts`）：

1. **必须是 `type: "command"`**——`http` / `mcp_tool` / `prompt` / `agent` 处理器会被跳过并警告。
2. **必须输出 JSON，且 `hookSpecificOutput.hookEventName` 必须等于 `"UserPromptSubmit"`**。类型声明原文：「Event discriminator claimed by `hookSpecificOutput`. **On mismatch, `parseHookOutput` preserves this value but discards event-scoped fields**」——写错事件名，你的上下文会被**静默丢弃**。
3. **纯 stdout 不算上下文**（Claude Code 方言下只当「输出」渲染；只有 Codex 方言才把 `SessionStart`/`UserPromptSubmit` 的纯 stdout 当 `additionalContext`）。所以脚本必须吐：
   ```json
   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}
   ```
4. **显式写 `timeout`**——桥接的默认是 **600 秒**（不是 Claude Code 的 30 秒）。

`UserPromptSubmit` 的支持度是「partial」：blocking 与 JSON `additionalContext` 可用，`sessionTitle` / `suppressOriginalPrompt` 不支持；该事件**忽略 matcher**，匹配到的 hook 串行执行、上下文按 hook 顺序累加。

> **取舍说明**：`dsh-hook-protocol` 官方指引是「没有参考工具对应的定制行为，就别走 hook 组，**原生 Cordis 插件有完整 harness API 且中间没有 hook 协议**」（`dsh-tmux-context` 就是原生插件）。我们仍选 hooks 面，**理由是跨宿主可移植**——这正是「让别人接到各自的工具链」的来源。若哪天只服务 DSH，应改写成原生插件。

---

## 4. 必须避开的格式陷阱

DSH 的 `@` 提及是 **path-only**——`FILE_REFERENCE_PROMPT` 原文：

> Tokens prefixed with @ are paths the user explicitly referenced. … Anything else is a file.

行号只存在于 **markdown 链接**的 GitHub 式片段：`parseFileLink` 解 `#L131`，且**区间折叠成起始行**（payload 只有 `line?: number`）。

因此：

| 写法 | 在 DSH 里 |
|---|---|
| `@src/auth.ts:11-14`（ctx-push 的输出） | ❌ 被当成名叫 `src/auth.ts:11-14` 的路径，找不到文件 |
| `@src/auth.ts` | ✅ 但**丢掉行号** |
| `[src/auth.ts:11-14](src/auth.ts#L11-L14)` | ✅ 点开跳到第 11 行（区间高亮做不到） |

**所以给 DSH 的输出必须是 markdown 链接形式或纯文字描述，不能是 `@path:line`。**

---

## 5. 设计决策（默认值，可改）

| 项 | 默认 | 理由 |
|---|---|---|
| 端口 | 固定 `63451`，占用则递增并写指针文件 `~/.editor-context/current.json` | MCP 客户端（DSH）需要静态 URL；固定端口零配置。多窗口用单实例 hub 汇总 |
| 绑定 | **仅 127.0.0.1** | 对标 selection-bridge / Claude Code |
| 鉴权 | 可选 token（写进 lock/指针文件），DSH 侧用 `headers: {Authorization: Bearer …}` | `StreamableHttpConfig` 有 `headers` 字段，可带 |
| 选区文本 | **默认只给路径 + 行范围**，文本按需（`get_selection` 显式请求，带上限） | 选区可能含密钥 |
| 排除 | 命中 gitignore / `files.exclude` / `search.exclude` 时连路径都不给 | 对标 Claude Code 的 `Read` deny 行为 |
| 注入时机 | **仅变化时注入** | 照抄 `dsh-tmux-context`，长会话不累积 token |

---

## 6. 待决

1. 扩展名/包名与发布渠道（VS Code Marketplace + Open VSX，Cursor 走 Open VSX）
2. 是否要 `open_at_range` 的**反向跳转**（MCP 面里就有；Pylon 已实现，可先不重复造）
3. 触发方式最终形态：每轮自动（hook）默认开，还是需要显式开关

---

## 附：本次调研的取证物

`.research/` 下：`ctxpush.md`（Context Push README）、`dp.md`（它复刻 Claude Code IDE bridge 的设计文档）、`pylon.md`、`selbridge.md`、`vscode-mcp.md`、`cursor-tph.html`（Cursor 第三方 hooks 映射表）、`agent-opens-design.md`（DSH `sidebar_open` 设计）。

关键本机证据：
- `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-hooks-claude-code/README.md:60-61,140-144` — UserPromptSubmit 可附加上下文
- `@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts:53-80` — streamable-http 配置形状
- `@deepseek-ai/dsh-file-reference/lib/types/index.d.ts:13` — `@` 提及 path-only
- `@deepseek-ai/dsh-client-ui-primitives/lib/types/markdown/file-link.d.ts` — `#L` 片段解析
- `@deepseek-ai/dsh-tmux-context/lib/types/index.d.ts:2-18` — 每轮注入范式
