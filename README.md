# dsh-task-badge

DSH Web 插件：在 favicon 和侧边栏显示运行中/已完成未读的任务计数。

## 功能

- **Favicon 角标**：蓝色=有任务运行中，红色=有已完成未读
- **侧边栏徽章**：显示运行中 + 未读数量，点击清除未读
- **实时追踪**：监听 `api-session/status` 事件追踪主会话状态，`jobs.onJobsChanged` 追踪后台任务

## 安装

```bash
cd ~/.dsh/profiles/web
npm install github:yourname/dsh-task-badge
```

然后在 `package.json` 的 `dsh.profile.bundles` 中添加 `"dsh-task-badge"`。

## 架构

| 层级 | 文件 | 说明 |
|------|------|------|
| Host | `lib/index.js` | Node.js 进程内运行，监听事件、提供 HTTP API |
| Client | `client/client.js` | 浏览器内运行，轮询 API、渲染 favicon 和侧边栏 UI |

Host 和 Client 通过 HTTP 路由通信（`/task-badge/counts`、`/task-badge/mark-viewed`），与 dshmarket 同一模式。

## 技术细节

- **不能**使用 `harness.handle`（只在 `cordis_define` 动态插件中可用）
- **不能**使用 ESM `export`（Client 必须用 `window.__ModuleLoader__.load()` 格式）
- Host 层 `jobs.list()` 只能看到无主任务，需通过 `onJobsChanged` 事件驱动追踪
- 使用 `api-session/status` 事件追踪主会话活跃状态（`idle` ⇄ `running`）
