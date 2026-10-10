# dsh-task-badge

Favicon + 侧边栏角标：实时显示**运行中**的会话/后台任务数与**未读**会话数。点击角标弹出明细卡片，每行解释一个计数并可点击跳到对应会话——角标只有数字时，用户常常找不到到底是哪个会话在跑后台任务。

## 计数怎么来

| 位置 | 职责 |
|------|------|
| `lib/index.js`（Host 半） | 监听 `api-session/status`、`api-session/activity`、`subagent/start`，订阅 `jobs.events`；对外开 `/task-badge/counts`、`/task-badge/state`（只读诊断，明细卡片的数据源）与 `/task-badge/mark-viewed` 三条路由 |
| `client/client.js`（浏览器半） | 每 3 秒先 `POST mark-viewed`（带上当前会话 id），**等它完成**再 `GET counts`，据此刷新侧边栏角标与 favicon 数字，并注册 `sidebar.footer.action` 插槽；点击角标打开明细卡片（`GET /task-badge/state`，打开期间随轮询刷新） |

明细卡片（`TaskCard`）UI 参考 dsh-quick-actions 的 popover：绝对定位在角标上方，仅用主题 token 上色，Esc / 点击外部 / × 按钮均可关闭。卡片分两节：**运行中**（运行会话 + 运行任务，任务行标注所属会话标题，无主任务只展示不可跳转）与**未读**（未读会话 + 有已完成未读任务的会话，两来源按会话去重合并）。点击任意行 `uiWorkspace.openSession()` 跳转并关卡片。会话标题取自 `sessions.list.getSnapshot().byId[id].displayTitle`，无标题时退化为短 id。

已读语义：会话被打开即从未读中移除，其名下已完成的后台任务一并记为已读；任务完成时你正停留在该会话里则不计入未读。你在别的会话期间完成的任务会计入未读。子代理会话不计入任何计数——Host 侧按 `subagent/start` 的 `id` 过滤，浏览器侧再按会话行的 `origin === 'subagent'` 兜底。

计数按**会话**去重：`unviewedJobs` 是「有未读任务且尚未计入未读列表的会话数」，同一会话的多个已完成任务只算 1；会话本身已在 `unreadSessionIds` 里时其任务不再重复累加——否则「未读会话 + 该会话已完成的任务」会把角标顶到 2，而它们其实是同一件要看的事。

### 依赖的 DSH 接口

这几处接口没有类型约束，升级 DSH 时值得复查：

- **当前会话**：`sessions.list.getSnapshot().byId` 中 `retainedBy.mainView > 0` 的那一行。快照本身**没有** `.current` 字段。
- **跳转**：`ctx.get('uiWorkspace').openSession(sessionId)`。`sessions` 服务只有 `retain` / `using` / `binding` / `retainInfo`，**没有** `open()`。
- **任务**：`jobs.events.subscribe({ owners: 'all' }, listener)`，事件形如 `{ type, job }`（`output` 事件只有 `id`）；任务视图是 `{ id, status, owner, ... }`，没有 `reported`。
- **子代理**：`subagent/start` 的载荷是 `{ runId, provider, id, local }`，`id` 即子会话 id，**没有** `sessionId` 字段。

### favicon

DSH 的 `index.html` 带**两条** icon link，按配色方案二选一：

```html
<link rel="icon" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />
<link rel="icon" href="./favicon.svg"      media="(prefers-color-scheme: light)" />
```

`document.querySelector("link[rel='icon']")` 只返回第一条，所以只改它的话，浅色模式下标签页始终显示没打角标的原图标。插件会把数字角标同时写到**每一条** icon link 上，并在计数归零时按原样还原各自的 `href` / `type`。

## 安装

见仓库根 [README](../README.md)。插件名 `dsh-task-badge`，加进 `package.json` 的 `dsh.profile.bundles` 即可；浏览器半声明的注入包是 `dsh-client-runtime`、`dsh-client-ui-sidebar`、`dsh-client-ui-workspace`。

## 测试

```bash
cd dsh-task-badge
node test/run.mjs      # Host 半：会话未读/已读、子代理过滤、后台任务计数、路由契约
node test/client.mjs   # 浏览器半：当前会话解析、请求顺序、明细卡片交互、双色 favicon
```

覆盖：会话运行态与未读态的转换、打开会话即已读、离开后新输出重新标记未读、`sessionId: null` 释放记忆、子代理在**事件先到、发现后到**时也能被清干净、`jobs.events` 的 `registered` / `settled` / `stopping` / `removed` / `output` 各类事件、无主任务不会变成永远清不掉的未读、无 jobs 服务时会话计数仍可用；客户端在打桩的 `window.__ModuleLoader__` 下装配，覆盖当前会话解析、`mark-viewed` 先于 `counts`、计数排除当前会话与子代理、点角标开卡片并向 Host 拉 state、任务行显示所属会话并可跳转、无主任务行不可跳转、未读两来源按会话去重合并、行点击跳转后关卡片、Esc/外部点击/×三种关闭途径、以及浅色/深色两套 icon link 的写入与还原。

## 卸载

从 `dsh.profile.bundles` 移除 `dsh-task-badge` 条目、删除 `dependencies` 中的条目与 `node_modules/dsh-task-badge` 目录，重启 `dsh web`；`cordis.patch.yml` 中的 `dsh-task-badge` 行可一并删除。
