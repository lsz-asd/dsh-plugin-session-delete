# dsh-plugin-session-delete

你是否困扰于 web 端无法删除对话？是否觉得归档对话键只是隐藏对话，删除得不够彻底？是否在尝试编辑 harness 时遇到对话话历史无法同步，而损坏的对话又无法删除？这个插件可以帮你！

**在 DeepSeek Harness 界面里安全地彻底删除会话。** 在会话顶部添加垃圾桶按钮，侧栏会话行 "..." 菜单内添加"删除会话"项，点击后出现风险确认弹窗（需勾选）；确认后会删除会话日志、投影缓存与工作区记账，并**自动删除会话中新产生的所有文件**（会话上传目录 + 工作区内会话新建的文件）；运行中的会话会有提示，若仍选择删除会停止运行并删除。可在web中使用，并且理论上兼容一切web套壳的客户端。
**添加agent工具让agent可以删除会话。** 工具名`workbench_session_delete`

## 安装

```sh
dsh plugin --profile <profile> add file:C:/path/to/dsh-plugin-session-delete
```

重启 profile 生效。

## 功能

- 会话头部垃圾桶按钮
- 侧栏会话行 "..." 菜单注入"删除会话"项
- `RiskConfirmation` 风险确认：勾选"我已了解后果"后确认可用
- 删除链路：会话目录 + 投影缓存 + 工作区记账（经活动 storageDomain，内存/磁盘一致）
- **会话文件自动清理**：删除会话时一并删除该会话期间新产生的文件（详见下节）
- `workbench_session_delete` 工具：agent 可直接删除会话
- 删除完成后的摘要页：显示清理了多少文件、保留了哪些被会话修改过的既有文件

## 会话文件自动清理（v0.4.0 起）

删除会话时，插件会自动清理该会话期间新产生的文件。判定规则：

**总是删除**
- 会话上传目录：`<工作区>/.dsh-uploads/<会话ID>/`（两种 id 形式都会清理；`.dsh-uploads` 清空后一并移除）

**基于基准账本（ledger，常规路径）**
- 插件在 `session/created` 时对会话工作区做一次快照（记录每个文件的相对路径 + mtime + 大小），存入 `<DSH_HOME>/plugin-data/chameleon-session-delete/ledgers/<会话ID>.json`
- 删除时将当前文件树与基准对比：基准中不存在的文件（= 会话新建）会被删除；会话期间清空后变空的**新建目录**也会被移除
- **既有文件只改不删**：会话修改过的既有文件（mtime/size 变化）会被保留，并在摘要中列出

**无账本时的回退（fallback）**
- 插件安装晚会话已存在、快照超限（>20 万条目）、或会话换过工作区时，没有基准可用
- 此时按文件系统的**创建时间（birth time）**判定：仅删除创建时间与修改时间都在会话创建时间（±250ms 容差）之后的文件；无法读取创建时间的文件一律保留
- 注意：Windows 上整文件重写会重置创建时间，因此会话**重写**过的既有文件在回退模式下可能被一并删除；账本模式（常规路径）不受影响

**边界与限制**
- 只处理会话工作区内的文件；工作区之外的绝对路径写入无法归因，不会删除
- **派生会话（fork / 子 agent）**：它们与父会话共享工作区，其文件产出计入父会话的基准；删除派生会话本身只清理其上传目录，**不扫描**工作区（避免误删父会话在 fork 之后创建的文件）。删除父会话会一并清理由其整个任务谱系（含 fork / 子 agent）产生的文件
- 符号链接只删除链接本身，绝不跟随或删除目标
- 快照与清理默认跳过这些目录（性能考虑，其内新增文件不会被清理）：`.git`、`.hg`、`.svn`、`node_modules`、`.venv`、`venv`、`__pycache__`、`.next`、`.nuxt`、`.output`、`target`、`.dsh`、`.dsh-uploads`
- 可用环境变量调整：`DSH_SESSION_DELETE_SKIP_DIRS`（逗号/分号分隔，覆盖默认跳过列表；设为空则不跳过）、`DSH_SESSION_DELETE_MAX_ENTRIES`（快照条目上限）
- 文件清理是尽力而为：个别被占用的文件删除失败不会中断会话删除，失败项会列入结果与摘要
- 账本在会话删除后自动移除

## 后续开发计划

- 添加更多针对会话的操作工具和选项
- 将已有的针对会话的选项做成工具提供给agent

<img width="1800" height="1020" alt="image" src="https://github.com/user-attachments/assets/c66f6185-457d-4261-9e10-1b44b9959896" />

## 更新日志

- **v0.4.0（2026-09-08）**：新增**会话文件自动清理**——删除会话时自动删除该会话期间新产生的所有文件：会话上传目录（`.dsh-uploads/<会话ID>/`）总是清理；工作区内会话新建的文件基于"基准账本"判定（`session/created` 时快照工作区，删除时对比，新建即删、修改保留），无账本时回退到文件创建时间（birth time）启发式；派生会话（fork / 子 agent）只清理上传目录、不扫描共享工作区。新增删除完成摘要页（zh/en），删除结果与 `workbench_session_delete` 工具输出包含文件清理统计；失败不阻塞会话删除。新增 `test/session-files.test.mjs` 单元测试。
- **v0.3.1（2026-08-14）**：修复删除会话后残留日志导致会话跑到「未分组」的问题。删除时同时清理原始 id 与 `session-` 前缀两种 id 形式；先删除磁盘日志并确认成功后再解除工作区记账，避免半删除会话脱离原分组；删除前先 flush 活动会话，防止 dispose 阶段回写/重建日志目录。
- **v0.3.0（2026-08-14）**：新增英文适配（i18n）。删除对话框、头部垃圾桶按钮与侧栏「删除会话」菜单项的全部文案接入客户端 zh/en 字典，跟随界面语言（设置中的语言或浏览器语言）自动切换并即时生效；未加载 locale 服务的环境会按浏览器语言回退到内置中英文字典。

---

# dsh-plugin-session-delete

Frustrated that sessions can't be deleted from the web client? Bothered by abandoned or mistyped conversations cluttering your sidebar? Ever tried editing your harness only to find the session history out of sync — with a corrupted session that just won't go away? This plugin has your back!

**Safely delete sessions from the DeepSeek Harness UI.** Adds a trash button at the top of the conversation and a "Delete session" item to the sidebar session-row "..." menu; clicking either opens a risk-consent dialog (checkbox required). On confirm, the session log, projection cache and workspace accounting are removed — and **all files newly produced during the session are auto-deleted** (the session upload dir + files the session created in the workspace). Running sessions show a warning — if you still choose to delete, the session is stopped and then deleted. Works in the web, and is theoretically compatible with any web-shell-based client.
**Also adds an agent tool so agents can delete sessions.** Tool name: `workbench_session_delete`

## Installation

```sh
dsh plugin --profile <profile> add file:C:/path/to/dsh-plugin-session-delete
```

Restart the profile to apply.

## Features

- Trash button at the top of the conversation
- "Delete session" item injected into the sidebar session-row "..." menu
- `RiskConfirmation` risk-consent dialog: confirm is only enabled after ticking "I understand the consequences"
- Delete chain: session log + projection cache + workspace accounting (through the active storageDomain, so in-memory state and on-disk units stay consistent)
- **Session file auto-cleanup**: deleting a session also removes every file it newly produced (see the section below)
- `workbench_session_delete` tool: agents can delete sessions directly
- Post-delete summary screen: shows how many files were cleaned up and which pre-existing (session-modified) files were kept

## Session file auto-cleanup (since v0.4.0)

When a session is deleted, the plugin also cleans up the files that session produced. The rules:

**Always deleted**
- The session upload directory: `<workspace>/.dsh-uploads/<sessionId>/` (both id spellings; `.dsh-uploads` itself is removed once empty)

**Baseline ledger (the normal path)**
- At `session/created` the plugin snapshots the session workspace (relative path + mtime + size per file) into `<DSH_HOME>/plugin-data/chameleon-session-delete/ledgers/<sessionId>.json`
- At delete time the current tree is diffed against that baseline: files absent from the baseline (= created by the session) are deleted, and newly-created directories that end up empty are pruned
- **Pre-existing files are never deleted for being modified**: files the session modified (mtime/size changed) are kept and listed in the summary

**Fallback when no ledger exists**
- Applies when the plugin was installed after the session started, the snapshot exceeded its cap (>200k entries), or the session moved workspaces
- Files are then attributed by filesystem **birth time**: a file is deleted only when both its birth time and mtime are at/after the session creation time (±250ms tolerance); files whose birth time is unavailable are always kept
- Note: on Windows, rewriting a file in place resets its creation time, so a pre-existing file the session *rewrote from scratch* may be removed in fallback mode; the ledger path is unaffected

**Boundaries**
- Only files inside the session workspace are handled; absolute-path writes outside the workspace cannot be attributed and are left alone
- **Derived sessions (forks / subagents)**: they share the parent's workspace and their file output is attributed to the parent's baseline. Deleting a derived session only cleans its upload dir and never scans the workspace (so files the parent created after the fork are never misattributed). Deleting the parent removes the files produced by its whole task lineage (forks and subagents included)
- Symlinks are removed as links only — targets are never followed or deleted
- The snapshot and the cleanup skip these directories by default (performance; new files inside them are not cleaned): `.git`, `.hg`, `.svn`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`, `.output`, `target`, `.dsh`, `.dsh-uploads`
- Tunables via environment: `DSH_SESSION_DELETE_SKIP_DIRS` (comma/semicolon-separated, replaces the default skip list; empty disables skipping) and `DSH_SESSION_DELETE_MAX_ENTRIES` (snapshot entry cap)
- File cleanup is best-effort: a locked file failing to delete never blocks the session deletion; failures are listed in the result and summary
- The ledger is removed together with the session

## Roadmap

- Add more session-operation tools and options
- Expose the existing session options to agents as tools

## Changelog

- **v0.4.0 (2026-09-08)**: Added **session file auto-cleanup** — deleting a session now also deletes every file it newly produced: the session upload dir (`.dsh-uploads/<sessionId>/`) is always removed, and workspace files created during the session are identified via a baseline ledger (workspace snapshotted at `session/created`, diffed at delete; new files deleted, modified pre-existing files kept), with a birth-time fallback when no ledger exists; derived sessions (forks/subagents) only get their upload dir cleaned and never scan the shared workspace. Added a post-delete summary screen (zh/en); the delete result and the `workbench_session_delete` tool output include file-cleanup statistics; failures never block the deletion. Added `test/session-files.test.mjs` unit tests.

- **v0.3.1 (2026-08-14)**: Fixed deleted sessions being left as "Ungrouped" rows after a partial delete. The host now cleans both raw UUID and `session-`-prefixed id forms, deletes the on-disk log and confirms it before removing workspace accounting (so a failed delete cannot detach a session from its group), and flushes a live session before detaching it to prevent dispose-time rewrites from recreating the log directory.
- **v0.3.0 (2026-08-14)**: Added English adaptation (i18n). All copy of the delete dialog, the header trash button and the sidebar "Delete session" menu item now lives in client zh/en dictionaries and follows the UI language (the language setting or the browser language), updating live on switch; environments without the locale service fall back to the built-in dictionaries by browser language.
