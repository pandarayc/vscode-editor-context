# editor-context-bridge

<img src="icon.png" width="96" alt="">

> **[English](README.md) · [中文](README.zh.md)**

把「你在 Cursor / VS Code 里正看着哪几行」发布出去，让同机运行的 agent 能读到那一段。

扩展只负责生产：每个编辑器窗口写一个小 JSON 文件，从不与 agent 通信。

```
~/.editor-context/windows/<扩展宿主 pid>.json
```

```json
{
  "version": 1,
  "pid": 9931,
  "appName": "Cursor",
  "updatedAt": "2026-10-16T10:25:58.977Z",
  "sig": "src/auth.ts|sel|11-14",
  "context": "[编辑器位置] /w/src/auth.ts 第 11-14 行",
  "workspaceFolders": ["/w"],
  "activeFile": "/w/src/auth.ts",
  "relativePath": "src/auth.ts",
  "languageId": "typescript",
  "selection": { "startLine": 11, "endLine": 14, "startColumn": 1, "endColumn": 5, "isEmpty": false }
}
```

一个窗口一个文件：不需要锁，也不会互相覆盖；读取方按 mtime 取最新。`selection`
和 `activeFile` 是结构化的读数，`context` 是同一件事预先渲染成的一行文本（给只想
直接拿去用的消费者），`sig` 在位置变化时才变——读取方靠它避免把同一句话说两遍。

**环境态文件里绝不含你的代码。** `windows/<pid>.json` 每次光标移动都会重写，所以它
始终只是一个地址。选中文本只在两种情况下离开编辑器：你显式点了 **Add to Bot**，或者
某个订阅者主动订阅了连续流；被 `excludeGlobs` 排除的路径永远不会。

## 订阅者

这个扩展是一个**发布者**：它描述你在哪，然后交给要它的人；它不知道任何消费者拿它做
什么。订阅者有两类，区别在于**什么会落到磁盘上**。

**进程内。** 兄弟扩展不需要任何文件系统，就能拿到每一次事件：

```ts
const api = vscode.extensions.getExtension('pandarayc.editor-context-bridge')?.exports;
const sub = api.subscribe((delivery) => { /* ... */ });
```

**走 socket。** 扩展默认在 `ws://127.0.0.1:7788/editor-context` 上跑一个 WebSocket
发布端。订阅者连上来，收到 `hello`，发一帧 `subscribe`，之后每次事件都会收到一帧
`delivery`——不用文件系统、不用轮询，而且投递到的时候你手还按在选区上。

```jsonc
// ← { "type": "hello", "protocol": "editor-context/1", "requiresToken": false, … }
→ { "type": "subscribe", "name": "dsh", "label": "DSH", "includeText": true, "autoSelection": false }
// ← { "type": "subscribed", "name": "dsh", "includeText": true, "autoSelection": false }
// ← { "type": "delivery", "delivery": { … } }
```

两个开关和 manifest 完全一致，所以不管订阅者从哪种传输进来，路由都是同一个函数。
**Editor Context: Show WebSocket Address** 会打印 URL 和已连接订阅者数量。

`ws.host` 非本机时**必须**设置 `ws.token`，否则拒绝启动；token 在应用策略**之前**
校验，所以猜错的客户端什么也学不到。

**磁盘上。** 连不进来的 agent 写一个 manifest 就完成了注册——这个文件就是全部协议，所以新的消费
者出现不需要更新扩展：

```
~/.editor-context/
├── windows/<pid>.json                    光标在哪，一直写（只有地址）
├── requests/<ts>-<pid>-<seq>.json        公开信箱：显式发送
└── subscribers/
    ├── dsh.json                          订阅者自己写的 manifest
    └── dsh/inbox/<ts>-<pid>-<seq>.json   定向投递
```

```json
{ "label": "DSH", "includeText": true, "autoSelection": false }
```

| 键 | 默认 | 含义 |
|---|---|---|
| `label` | 文件名 | 选择器里显示的名字 |
| `includeText` | `true` | 投递是否带选中文本。`false` 只发地址 |
| `autoSelection` | `false` | 是否连**每一次变化的非空选区**都投递，而不只是显式发送 |

**Editor Context: Add to Bot**（编辑器标题栏、右键菜单、命令面板）把当前位置发给**所有**
已注册订阅者，并写入公开信箱。**Add to Bot (choose recipient)…** 只发给其中一个，而且
那一份是**私密的**：不会抄送到公开信箱。

公开信箱是给无法注册的消费者准备的。hook 脚本只在发消息时运行，没地方放 manifest，
它直接读 `requests/` 就行。

### 订阅者收到什么

位置相关字段与那个环境态文件**同名**，所以已经在解析 `windows/<pid>.json` 的读取端能
在预期的地方找到它们：

```json
{
  "version": 1,
  "kind": "editor-context/delivery",
  "id": "0f0b2c1e-…",
  "at": "2026-10-17T06:12:00.000Z",
  "reason": "explicit",
  "target": "dsh",
  "activeFile": "/w/src/auth.ts",
  "relativePath": "src/auth.ts",
  "languageId": "typescript",
  "selection": { "startLine": 11, "endLine": 14, "startColumn": 1, "endColumn": 5, "isEmpty": false },
  "context": "[编辑器位置] /w/src/auth.ts 第 11-14 行",
  "text": "export function login(user: User) {\n  …",
  "textTruncated": false
}
```

`text` 会被 `editorContext.maxTextBytes` 截断，`textTruncated` 会说明。超过 5000 行的
选区不会继续往下读。

**`excludeGlobs` 命中时是「不产生投递」，不是「产生一条空的」。** 这条规则管的是路径
有没有出现在消息里，所以一条把地址抹掉的载荷等于没守规矩。

## 先选你的 agent

| Agent | 装什么 | 位置以什么形式到达 |
|---|---|---|
| **DSH** | [`dsh-editor-context`](https://github.com/pandarayc/dsh-editor-context) | 输入框里的一张 chip —— 从 `@` 选，或者直接用按钮 —— **用这个** |
| **Claude Code** | [hook](#hook不推荐) | 位置变化时自动注入 |
| 其他 | 什么都不用装 | 直接读 JSON |

### hook（不推荐）

仓库里带了一个 `UserPromptSubmit` hook，给没有扩展 API 的编辑器、或只读 prompt 的
agent 用。**接 DSH 就别装它。** 实测：光标动得多时它每回合追加一条 durable user
消息——位置是高基数去重键，「变了才注入」的去重实际上从不命中。chip 就是这次实测的
产物。

```bash
node scripts/install-dsh-hook.mjs              # 复制脚本、合并 hooks.json
node scripts/install-dsh-hook.mjs --print      # 只打印条目，不写盘
```

它会保留已有 hook，且幂等。要移除，删掉 `~/.dsh/hooks/hooks.json` 里的
`UserPromptSubmit` 条目和复制过去的 `editor_context.py` 即可；DSH 只在进程启动时读
一次这个文件，所以装和删都要重启。

## 安装

### 从 Marketplace 装

```
pandarayc.editor-context-bridge
```

`code --install-extension pandarayc.editor-context-bridge`（Cursor 把 `code` 换成
`cursor`），或在扩展面板里搜 **Editor Context**。

### Remote-SSH：Cursor 跑在另一台机器上

远端窗口里**没有** `cursor` CLI（CLI 在客户端那台机器上），所以扩展必须装进
**服务器侧**的扩展目录。做这件事的脚本放在本仓库里而不是 VSIX 里——需要它的那台
机器，恰恰是跑不了 `cursor` 的那台。

```bash
node scripts/install-cursor-remote.mjs --vsix ./editor-context-bridge-<version>.vsix
```

它把 VSIX 解到
`~/.cursor-server/extensions/<publisher>.editor-context-bridge-<version>/`，
再把条目写进 `extensions/extensions.json`——**会先备份**，而且幂等（重跑替换旧条目，
不追加重复）。默认探测 `~/.cursor-server`，没有就退到 `~/.vscode-server`；用
`--server <dir>` 显式指定。**装完不用重启**，扩展宿主会自己激活它。

### 本机窗口

```bash
cursor --install-extension editor-context-bridge-<version>.vsix
# 或命令面板：Extensions: Install from VSIX…
```

VS Code 同理：`code --install-extension`。

### 开发模式

```bash
npm install --cache ../.npm-cache
npm run compile
# 用 Cursor 打开本目录，按 F5 起 Extension Development Host
```

然后打开一个文件、划选几行：

```bash
cat ~/.editor-context/windows/*.json
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `editorContext.enabled` | `true` | 关掉会**删除**本窗口的状态文件 |
| `editorContext.excludeGlobs` | `.env` / `.env.*` / `*.pem` / `*.key` / `id_rsa*` / `id_ed25519*` / `.ssh/**` / `node_modules/**` | **命中就连路径都不发布**，不只是隐去文本。含 `/` 的模式匹配工作区相对路径，不含 `/` 的匹配文件名 |
| `editorContext.language` | `zh` | `context` 那一行的语言：`zh` / `en` |
| `editorContext.sendText` | `true` | 投递是否包含选中文本。**不影响**环境态文件 |
| `editorContext.maxTextBytes` | `20000` | 该文本的字节预算；`0` 表示不限制 |
| `editorContext.ws.enabled` | `true` | 是否运行 WebSocket 发布端 |
| `editorContext.ws.host` | `127.0.0.1` | 绑定地址。非本机时没有 token 会被拒绝 |
| `editorContext.ws.port` | `7788` | `0` 表示自动选端口，地址每次重启都会变 |
| `editorContext.ws.path` | `/editor-context` | 端点路径 |
| `editorContext.ws.token` | 空 | `subscribe` 帧必须携带的共享密钥 |
| `editorContext.stateDir` | 空 → `~/.editor-context` | 换目录 |
| `editorContext.debounceMs` | `150` | 光标移动写盘前的静默窗口 |

命令面板里有四条命令：**Add to Bot** 和 **Add to Bot (choose recipient)…**（见上）、
**Show State File**（打开本窗口正在写的文件）、**Copy Current Position as Context**
（把 `context` 那行拷进剪贴板）。

`editorContext.sendToAgent` 仍注册为 **Add to Bot** 的别名，所以在 0.2.0 上写的快捷键
不会失效。

## 已知限制

- **只做寻址，不做整段高亮。** 让编辑器跳到某个区间需要一条入站通道，扩展没有。
- **多窗口时取最近更新的那个。** 没有「哪个窗口是焦点窗口」的跨进程判定。

hook 另有自己的坑（缓存可能被迫落进项目里、位置没变时不重复注入），这也是它不推荐
的原因，详见 [hook（不推荐）](#hook不推荐)。

## 内部细节

`src/core.ts` 是纯逻辑——位置模型、glob 排除、渲染——不 import `vscode`，所以能在
裸 Node 下单测。`src/state.ts` 负责原子写，`src/extension.ts` 是事件接线，
`hooks/editor_context.py` 是零依赖的 Python 3.8+ `UserPromptSubmit` hook。

```bash
npm run compile && npm test    # 63 passed
```

关于「为什么渲染只有一行」「为什么 `context: ''` 同时表示两件事」，以及 hook 不能
踩的四条契约：[docs/internals.md](docs/internals.md)。最初的调研与设计记录在
[docs/design.md](docs/design.md)。

## License

MIT
