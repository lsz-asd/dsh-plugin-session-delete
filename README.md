# dsh-plugin-session-delete

你是否困扰于 web 端无法删除对话？是否觉得归档对话键只是隐藏对话，删除得不够彻底？是否在尝试编辑 harness 时遇到对话话历史无法同步，而损坏的对话又无法删除？这个插件可以帮你！

**在 DeepSeek Harness 界面里管理归档会话。** 侧边栏新增“归档管理”入口，菜单列出全部已归档会话，并为每一项提供“恢复”和“删除”；恢复会保留原日志、统计和工作区位置，删除仍会经过风险确认并彻底清理。会话顶部和行菜单仍提供归档操作；运行中的会话归档不会停止任务。可在 Web 与桌面客户端中使用。
**同时提供归档、恢复和删除 agent 工具。** 工具名：`workbench_session_archive`、`workbench_session_restore`、`workbench_session_delete`

## 安装

```sh
dsh plugin --profile <profile> add file:C:/path/to/dsh-plugin-session-delete
```

重启 profile 生效。

## 功能

- 侧边栏“归档管理”菜单：列出已归档会话，并支持逐项恢复/删除
- 会话头部归档按钮与垃圾桶按钮
- 侧栏会话行 "..." 菜单提供"归档会话"与"删除会话"项（原生菜单已有归档时自动避免重复）
- `RiskConfirmation` 风险确认：勾选"我已了解后果"后确认可用
- 删除链路：会话目录 + 投影缓存 + 工作区记账（经活动 storageDomain，内存/磁盘一致）
- `workbench_session_archive` 工具：agent 可调用官方归档语义
- `workbench_session_restore` 工具：agent 可恢复归档会话
- `workbench_session_delete` 工具：agent 可直接删除会话

## 后续开发计划

- 添加更多针对会话的操作工具和选项
- 将已有的针对会话的选项做成工具提供给agent
- 
<img width="1800" height="1020" alt="image" src="https://github.com/user-attachments/assets/c66f6185-457d-4261-9e10-1b44b9959896" />

## 更新日志

- **v0.5.0（2026-08-23）**：新增“归档管理”菜单：列出已归档会话，支持逐项恢复和带确认删除；新增 `/__chameleon/session/archive/list`、`/__chameleon/session/archive/restore` 端点与 `workbench_session_restore` 工具；恢复通过工作区 registry 串行更新归档集合，保留日志、统计和原工作区位置。
- **v0.3.1（2026-08-14）**：修复删除会话后残留日志导致会话跑到「未分组」的问题。删除时同时清理原始 id 与 `session-` 前缀两种 id 形式；先删除磁盘日志并确认成功后再解除工作区记账，避免半删除会话脱离原分组；删除前先 flush 活动会话，防止 dispose 阶段回写/重建日志目录。
- **v0.3.0（2026-08-14）**：新增英文适配（i18n）。删除对话框、头部垃圾桶按钮与侧栏「删除会话」菜单项的全部文案接入客户端 zh/en 字典，跟随界面语言（设置中的语言或浏览器语言）自动切换并即时生效；未加载 locale 服务的环境会按浏览器语言回退到内置中英文字典。

---

# dsh-plugin-session-delete

Frustrated that sessions can't be deleted from the web client? Bothered by abandoned or mistyped conversations cluttering your sidebar? Ever tried editing your harness only to find the session history out of sync — with a corrupted session that just won't go away? This plugin has your back!

**Manage archived sessions from the DeepSeek Harness UI.** Adds an "Archive manager" entry to the sidebar footer. The manager lists every archived session and provides per-session Restore and Delete actions. Restore keeps the log, statistics, and original workspace position; Delete keeps its risk-consent dialog and permanently removes persisted data. The header and session-row archive actions remain available, and archiving a running session does not stop its task. Works in both the web and desktop clients.
**Also adds agent tools for archive, restore, and delete.** Tool names: `workbench_session_archive`, `workbench_session_restore`, and `workbench_session_delete`

## Installation

```sh
dsh plugin --profile <profile> add file:C:/path/to/dsh-plugin-session-delete
```

Restart the profile to apply.

## Features

- "Archive manager" sidebar entry listing archived sessions with Restore/Delete actions
- Archive and trash buttons at the top of the conversation
- "Archive session" and "Delete session" actions in the sidebar session-row "..." menu (the fallback archive item is skipped when the native item exists)
- `RiskConfirmation` risk-consent dialog: confirm is only enabled after ticking "I understand the consequences"
- Delete chain: session log + projection cache + workspace accounting (through the active storageDomain, so in-memory state and on-disk units stay consistent)
- `workbench_session_archive` tool: agents can use the official archive semantics
- `workbench_session_restore` tool: agents can restore archived sessions
- `workbench_session_delete` tool: agents can delete sessions directly

## Roadmap

- Add more session-operation tools and options
- Expose the existing session options to agents as tools

## Changelog

- **v0.5.0 (2026-08-23)**: Added the Archive manager sidebar entry. It lists archived sessions and provides per-session Restore and confirmed Delete actions. Added `/__chameleon/session/archive/list`, `/__chameleon/session/archive/restore`, and `workbench_session_restore`; restore updates the Workspace registry archive set serially while retaining logs, statistics, and workspace position.
- **v0.3.1 (2026-08-14)**: Fixed deleted sessions being left as "Ungrouped" rows after a partial delete. The host now cleans both raw UUID and `session-`-prefixed id forms, deletes the on-disk log and confirms it before removing workspace accounting (so a failed delete cannot detach a session from its group), and flushes a live session before detaching it to prevent dispose-time rewrites from recreating the log directory.
- **v0.3.0 (2026-08-14)**: Added English adaptation (i18n). All copy of the delete dialog, the header trash button and the sidebar "Delete session" menu item now lives in client zh/en dictionaries and follows the UI language (the language setting or the browser language), updating live on switch; environments without the locale service fall back to the built-in dictionaries by browser language.
