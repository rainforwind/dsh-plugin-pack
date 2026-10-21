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

1. 会话必须在**归档集合**里（守卫先于存在性检查——普通会话一律拒绝）；
2. 目标目录必须解析在 persistence root 之内（先于一切副作用校验）；
3. 驻留与活动双重结算：会话若还驻留在进程里（Session/Agent 对象未释放）或有正在
   运行的回合，先通过 `workspace/session-stop` 停止（与归档流程同一机制）并轮询最多
   8 秒；仍驻留（通常是某个会话视图未关闭）或仍运行则拒绝。**驻留检查不可省**——
   主机的会话列表 = 磁盘 ∪ 驻留实例，文件删了但实例还在会以幽灵行复活。

**强制删除（force）**：驻留的注册表没有按 id 释放的 API（唯一全局 `disposeInitiators`
会杀掉一切，包括当前会话），所以对**驻留但空闲**的会话提供逃生门——确认框在收到
`resident` 拒绝后出现「强制删除」按钮，请求带 `force: true`。宿主强制要求
**activity == 0**：`force` 只绕过驻留、从不绕过正在运行的回合（有活动回合时
`force` 依旧返回 `live` 拒绝）。被强制删除的会话其内存实例会存活到下次重启，但
归属已 detach、`api-session/removed` 已发出，行不会回列表（重启后实例随进程消失，
彻底干净）。`session_delete` 工具**永不**强制。

删除成功后界面会给一条结果提示：普通删除说「会话已删除」，强制删除会额外说明
「内存实例保留到 DSH 重启、期间已从列表移除」，避免之后在日志或注册表里看到痕迹时
产生误解。

> 关于「是否每次都得重启」：不需要。重启只是清零**当前进程**的驻留表，之后任何被
> 打开或开机恢复的会话会再次驻留。因此策略是能直接删就直接删，被 `resident` 拒绝时
> 用强制删除，全程无需重启。

删除顺序：先 unarchive（持久化、可恢复）→ 删除磁盘上的会话目录 → 复查归档集合（并发
归档变更可能丢失更新——自愈再 unarchive 一次）→ 从 workspace 记录中 `detachSession`
（清掉持久的 `sessionIds` 归属，防止归属+摘要重新拼出行）→ 发出 `api-session/removed`
让客户端列表立刻丢弃缓存摘要。

**幽灵残留**（归档集合里有、但文件早已不存在的历史残留）走同一路径：`stat` 缺失时不
报 not-found，而是做一次无表头的兜底清扫（扫 persistence root 下每层项目目录的
`<encoded-id>` 残留并 force rm，含 `_no-cwd` 布局），然后照常 unarchive + detach +
removed，把归档条目和行一起清掉。删除入口的门禁只看 `archived`，因此幽灵行也能删除
（确认框会用专门文案说明「会话文件已不存在，清除的是残留记录」）。

磁盘路径推导与 JSONL 后端完全一致：
`<root>/--<normalized-cwd>--/<encoded-id>/`（无 cwd 时为 `<root>/_no-cwd/<encoded-id>/`）。

## HTTP 接口（浏览器半与 Host 半通信）

- `GET /dsh-session-manager/state?sessionId=…` →
  `{ ok, state: { exists, archived, live, resident: { sessions, agents },
  activity, activityUnknown, parentSession?, isSeeded } }`（诊断拆分：
  `resident` 说哪个注册表持有实例，`activity` 是活动回合数，`parentSession`
  标出委托子会话——拒绝消息会点名父级）
- `POST /dsh-session-manager/delete` body `{ sessionId, force? }` →
  `{ ok: true, ghost, forced }` 或 `{ ok: false, error: <code>, message }`

## 注意

- 需要 `dsh-session-persistence-jsonl` 后端（读取其 `root`）；其他后端会明确拒绝。
- 删除不可撤销；建议配合 DSH 备份/快照使用。
