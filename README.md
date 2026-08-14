# dsh-plugin-session-delete

**在 DeepSeek Harness 界面里安全删除会话。** 头部危险按钮 + 侧栏会话行 "..." 菜单的"删除会话"项，风险确认弹窗（需勾选）；删除会话日志、投影缓存与工作区记账；运行中的会话拒绝删除。web 与桌面客户端通用。

## 安装

```sh
dsh plugin --profile <profile> add github:lsz-asd/dsh-chameleon  # 或
dsh plugin --profile <profile> add file:C:/path/to/workbench-session-delete
```

重启 profile 生效。

## 功能

- 会话头部 🗑 删除按钮（`conversation.session.header.actions`，order 30）
- 侧栏会话行 "..." 菜单注入"删除会话"项（rc.6 菜单无扩展槽，DOM 注入）
- `RiskConfirmation` 风险确认：勾选"我已了解后果"后确认可用
- 删除链路：会话目录 + 投影缓存 + 工作区记账（经活动 storageDomain，内存/磁盘一致）
- 运行中会话：409 拒绝（host）+ 按钮禁用（client）
- `workbench_session_delete` 工具：agent 可直接删除会话

## 兼容性

- host 仅硬依赖 `tools`；`webServer` 可选（无 web 面的 profile 只注册工具，不挂起）
- 客户端模块需 `inject: ['slots']`
