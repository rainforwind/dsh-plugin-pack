# dsh-session-manager

已归档会话管理插件：为 DSH 补上「删除已归档会话」的入口。

DSH 目前的会话存储（`@deepseek-ai/dsh-session-persistence-jsonl`）明确不提供任何删除 API——
日志文件会一直保留在磁盘上，已归档（隐藏）的会话在界面上也没有删除入口。本插件补上这一缺口：

- **侧边栏会话行菜单**：在会话行的 “…” 菜单末尾（Archive 之后）新增 **删除…** 项，对所有
  已归档会话显示；点击后弹出确认框，明确说明不可恢复。
- **agent 工具 `session_delete`**：同一个删除操作暴露给 agent，参数 `sessionId`，同样只能
  删除已归档的会话。

## 安全边界

删除是不可逆操作，Host 端在执行时重新校验（UI 与工具走同一份核心逻辑）：

1. 会话必须存在于 session persistence；
2. 会话必须在**归档集合**里（普通会话一律拒绝）；
3. 如有正在运行的回合，先通过 `workspace/session-stop` 停止（与归档流程同一机制）并等待
   结算；仍停不下来的拒绝删除。空闲的会话对象挂在进程里不阻塞删除。
4. 目标目录必须解析在 persistence root 之内。

删除顺序：先 unarchive（持久化、可恢复）→ 再删除磁盘上的会话目录 → 发出
`api-session/removed` 让客户端列表立刻刷新。会话在 workspace 记录里的残留归属会在下次
workspace 变更或重启时被头校验自动清理。

磁盘路径推导与 JSONL 后端完全一致：
`<root>/--<normalized-cwd>--/<encoded-id>/`（无 cwd 时为 `<root>/_no-cwd/<encoded-id>/`）。

## HTTP 接口（浏览器半与 Host 半通信）

- `GET /dsh-session-manager/state?sessionId=…` → `{ ok, state: { exists, archived, live } }`
- `POST /dsh-session-manager/delete` body `{ sessionId }` → `{ ok: true }` 或
  `{ ok: false, error: <code>, message }`

## 注意

- 需要 `dsh-session-persistence-jsonl` 后端（读取其 `root`）；其他后端会明确拒绝。
- 删除不可撤销；建议配合 DSH 备份/快照使用。
