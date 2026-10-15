# editor-context
> **[English](README.md) · [中文](README.zh.md)**

把「你在 Cursor / VS Code 里正看着哪几行」发布出去，让任意 agent 都能知道。

一个扩展，一个采集源，多个消费者：**状态文件**（当前这一版的全部内容）、一个 **Claude Code hook**，以及 —— 对 DSH 而言 —— 一个独立的插件，把读数变成输入框里的一张 chip。

> 为什么不是 `@path:11-14`：DSH 的 `@` 提及**只认路径**，行号只存在于 markdown 链接的 `#L11-L14` 片段。本扩展产出的是**给模型看的自然语言描述**，不产出 `@` 记号——那种写法在 DSH 里会被当成一个叫 `src/auth.ts:11-14` 的文件。

---

## 它做什么

光标一动、选区一变、切文件，扩展就把当前位置原子地写进：

```
~/.editor-context/
└── windows/
    └── <扩展宿主 pid>.json     # 每个编辑器窗口一个文件
```

**每个窗口写自己的文件**——VS Code/Cursor 每个窗口一个扩展宿主进程，所以不需要锁，也不会互相覆盖；读取方按 mtime 取最新。

单个窗口文件长这样：

```json
{
  "version": 1,
  "pid": 9931,
  "appName": "Cursor",
  "updatedAt": "2026-10-14T10:30:33.921Z",
  "sig": "editor-context/src/core.ts|sel|11-14",
  "context": "[编辑器位置] 用户当前在 Cursor 里选中了 editor-context/src/core.ts 第 11-14 行（共 4 行）。\n绝对路径：/data/project/dsh-plugin/editor-context/src/core.ts\n需要看内容时用 read 工具读该区间（offset=11, limit=4）。",
  "workspaceFolders": ["/data/project/dsh-plugin"],
  "activeFile": "/data/project/dsh-plugin/editor-context/src/core.ts",
  "relativePath": "editor-context/src/core.ts",
  "languageId": "typescript",
  "selection": { "startLine": 11, "endLine": 14, "startColumn": 1, "endColumn": 40, "isEmpty": false }
}
```

- `context` 是**已经渲染好**的注入文本——格式化逻辑只有一份（在 TypeScript 里），hook 脚本不做拼装，避免两处措辞漂移。
- `sig` 是位置的稳定签名（文件 + 行范围 + 是选区还是光标）。列号变化不算变化，所以同一行里左右移动光标不会反复注入。
- **不采集选中文本**。当前版本只发布「哪个文件的哪几行」。

---

## 安装

### 方式一：Remote-SSH / 远端（Cursor 跑在另一台机器上）

远端窗口里**没有** `cursor` CLI（CLI 在客户端那台机器上），所以扩展必须装进**服务器侧**的扩展目录。脚本要从本仓库取（它**故意不放进 VSIX**：需要它的那台机器恰恰是跑不了 `cursor` 的那台）：

```bash
node scripts/install-cursor-remote.mjs --vsix ./editor-context-0.1.0.vsix
```

它做两件服务端本来会做的事：把 VSIX 解到 `~/.cursor-server/extensions/local.editor-context-0.1.0/`（`.vsixmanifest` 改名成点号形式），并把条目写进 `extensions/extensions.json`（**会先备份**，且幂等——重跑会替换旧条目而不是追加）。默认探测 `~/.cursor-server`，没有就退到 `~/.vscode-server`；用 `--server <dir>` 显式指定。

**实测：装完不需要手动重启**——Cursor 的扩展宿主会自己激活它，`~/.editor-context/windows/` 立刻出现文件。

### 方式二：本机窗口（Cursor / VS Code 就装在这台机器上）

```bash
cursor --install-extension editor-context-0.1.0.vsix
# 或用命令面板：Extensions: Install from VSIX…
```

VS Code 同理，`code --install-extension` 即可（两边是同一套扩展 API）。

### 方式三：开发模式

```bash
cd editor-context
npm install --cache ../.npm-cache
npm run compile
# 用 Cursor 打开本目录，按 F5 起 Extension Development Host
```

装完打开任意文件、划选几行，然后：

```bash
cat ~/.editor-context/windows/*.json
```

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `editorContext.enabled` | `true` | 关掉会**删除**本窗口的状态文件 |
| `editorContext.stateDir` | 空 → `~/.editor-context` | 换目录 |
| `editorContext.excludeGlobs` | `.env` / `*.pem` / `*.key` / `id_rsa*` / `id_ed25519*` / `.ssh/**` / `node_modules/**` | **命中就连路径都不发布**（不只是隐去文本）。含 `/` 的模式匹配工作区相对路径，不含 `/` 的匹配文件名 |
| `editorContext.language` | `zh` | 注入文本语言，`zh` / `en` |
| `editorContext.debounceMs` | `150` | 光标抖动的合并窗口 |

命令面板里还有 `Editor Context: Show State File` 和 `Copy Current Position as Context`（后者把描述文本拷进剪贴板，可手动粘给任何 agent）。

---

## 接到 DSH

> **用 DSH 的话先读这段。** 进 DSH 有两条路，而 hook 是错的那条。
>
> 插件 **[`dsh-editor-context`](https://github.com/pandarayc/dsh-editor-context)** 读这些状态文件，把位置作为 chip 提供在输入框里 —— 是你打的字，进你自己的消息。
>
> 下面的 hook 每个 prompt 自动注入。在 DSH 上实测：光标动得多时它**每回合追加一条 durable user 消息** —— 去重键是精确位置，而高基数去重键等于没有去重。保留它，是为了服务那些不接 DSH 的编辑器。

用带上的脚本（幂等，**会先备份** `hooks.json`，并且保留你已有的 `PreToolUse` / `PostToolUse`）：

```bash
node scripts/install-dsh-hook.mjs            # 先看会写什么：加 --print
```

它把 `hooks/editor_context.py` 复制进 `~/.dsh/hooks/`，并在 `~/.dsh/hooks/hooks.json` 里合并一条 `UserPromptSubmit`：

```json
{
  "UserPromptSubmit": [
    {
      "hooks": [
        { "type": "command", "command": "python3 \"$HOME/.dsh/hooks/editor_context.py\"", "timeout": 5 }
      ]
    }
  ]
}
```

手动做也一样：把脚本复制过去，再把上面这段合并进 `hooks` 对象即可。

**然后必须重启 dsh-web** —— `configPath` 在 DSH 进程启动时只读一次（`~/.dsh/profiles/web/cordis.patch.yml` 里已有这条备注）。

### 四条硬契约（写错会静默失效）

来自 `@deepseek-ai/dsh-hook-protocol` 的类型声明，本脚本已全部满足，改动时别踩：

| 契约 | 说明 |
|---|---|
| `type` 必须是 `command` | `http` / `mcp_tool` / `prompt` / `agent` 处理器会被跳过并警告 |
| `hookSpecificOutput.hookEventName` 必须等于 `"UserPromptSubmit"` | **不匹配时事件域字段（含 `additionalContext`）被静默丢弃** |
| 必须是 JSON，不能靠纯 stdout | Claude Code 方言把纯 stdout 当「输出」渲染，不当上下文 |
| 显式写 `timeout` | 桥接默认 600 秒，不是 Claude Code 的 30 秒 |

`UserPromptSubmit` 忽略 matcher；匹配到的 hook 串行执行，上下文按 hook 顺序累加。

### 验证

```bash
echo '{"session_id":"t1"}' | python3 ~/.dsh/hooks/editor_context.py   # 有位置时打印 JSON
echo '{"session_id":"t1"}' | python3 ~/.dsh/hooks/editor_context.py   # 位置没变 → 无输出（0 字节）
```

`EDITOR_CONTEXT_DIR` 可覆盖状态目录；`EDITOR_CONTEXT_MAX_AGE_SECONDS`（默认 3600）之后的状态视为过期、不注入。

---

## 接到 Claude Code

同一份脚本，放进 `~/.claude/settings.json` 即可（Claude Code 原生认这个格式）。注意 Claude Code 的 `UserPromptSubmit` 支持纯 stdout 上下文与 JSON 两种，本脚本用的 JSON 形式两边都认。

---

## 为什么是 hook，不是只做 MCP

MCP 是**拉取式**的：模型调用工具才拿到数据，它无法把「你正在看第 12 行」推进 prompt。Claude Code 官方的 IDE 集成就是这么切的——它的 IDE server 只把 2 个工具暴露给模型，选区共享走的是 harness 侧的上下文注入。

所以分工是：

| 面 | 覆盖 | 状态 |
|---|---|---|
| 状态文件 + hook | 每轮自动知道（模型不用问） | ✅ 本版本 |
| MCP server | 模型主动查「我在看什么」、让 IDE 跳到某行 | 🚧 规划中 |

`dsh-hook-protocol` 的官方指引也提醒过：若只服务 DSH，**原生 Cordis 插件**比走 hook 桥接更干净（有完整 harness API）。这里选 hook 面，是为了**同一份脚本能同时接 Claude Code / DSH / Cursor**。

---

## 目录

```
src/core.ts        纯逻辑：位置模型、glob 排除、渲染（无 vscode 依赖，可单测）
src/state.ts       原子写 windows/<pid>.json
src/extension.ts   VS Code 事件接线
hooks/editor_context.py   UserPromptSubmit hook（零依赖 Python 3.8+）
test/core.test.mjs        10 个纯逻辑用例
test/hook.test.mjs        11 个 hook 端到端用例
```

```bash
npm run compile && npm test    # 21 passed
```

## 已知限制

- **hook 的「变了才注入」缓存可能需要落进你的工作区。** hooks 由 DSH 的 `ShellExecutor`（`@deepseek-ai/dsh-shell`）起进程，会继承会话的文件沙箱——`~/.editor-context` **可读但不可写**。去重缓存因此按顺序找位置：先试状态目录，失败就退到 `<会话cwd>/.dsh/editor-context/<session>.sig`。项目里多出 `.dsh/editor-context/` 就是它，可加进 `.gitignore`。两处都写不进去时，hook 退回「每轮都注入」而不是静默失效。
- **只跳单行**：这里不做「高亮 12-15 整段」——DSH 的 `#L` 片段本身也只承载单行（`WorkspaceFileParams.line`）。要区间高亮得靠 IDE 侧自己的能力。
- **变化才注入**：位置没变就不重复注入（省 token）。副作用是压缩（compact）之后若位置一直没动，那行描述可能不在上下文里了——动一下光标即可重新注入。
- 多窗口时取**最近更新**的那个窗口；没有「哪个窗口是活动窗口」的跨进程判定。
