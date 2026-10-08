# dsh-quick-actions

在 DSH 界面上植入**快捷操作按钮**：点击执行一条 shell 命令，执行中/执行后都能实时查看输出；按钮的作用范围（scope）与运行实例的共享方式均可自定义——全局、某个 workspace、或某个会话。

按钮渲染在两处：**会话头部**（`conversation.session.header.actions`，跟随当前会话）与**侧边栏底部**（`sidebar.footer.action`，任何界面常驻）。两处末尾都有一个「+」按钮，唤起配置面板。

## 按钮定义从哪来

两层来源，合并展示：

| 来源 | 写在哪 | 可否在面板里改 |
|------|--------|----------------|
| 静态定义 | `cordis.patch.yml` 里插件行的 `config.buttons` | 只读（面板中灰底展示） |
| 运行时定义 | 「+」面板增删改，落盘到 JSON store | 可以 |

JSON store 默认路径：`$DSH_PROFILE_DIR/dsh-quick-actions.json`，未设置该环境变量时为 `~/.dsh/dsh-quick-actions.json`，可用 `config.storePath` 覆盖。写入采用「临时文件 + rename」的原子替换；校验失败的条目连同字段名一起回给面板，不会半写。

一条定义的字段：

```yaml
- id: clean          # 必填，小写字母/数字/- _ . ，全列表唯一（config 里的 id 预留）
  label: Clean       # 必填，按钮文字
  icon: '🧹'         # 可选，1-8 字符（emoji）
  command: rm -rf {workspace}/dist   # 必填；支持 {workspace}、{session} 占位符
  workdir: /srv/app  # 可选；缺省时依次取 config.workdir → workspace 目录
  scope: workspace   # global | workspace | session，默认 global
  target: ws-a       # 可选，钉死到某个 workspace id / session id
```

`{workspace}` / `{session}` 在事实已知时展开（workspace 目录、当前会话 id），未知时**保留字面量**——占位符没被展开必须看得见，而不是静默变成空串。

## scope 的两层含义

一个 `scope` 同时决定**按钮定义的可见性**和**运行实例的共享性**：

| scope | 定义可见性 | 运行实例 |
|-------|-----------|----------|
| `global` | 任何上下文 | `g:<id>` ——所有人共享同一次运行 |
| `workspace`（无 target） | 任何会话 | `w:<id>:<workspaceId>` ——每个 workspace 一份；未分组会话共用 `w:<id>:` 这一份 |
| `workspace`（`target: ws-a`） | 只在 ws-a 的会话里 | 同上，且只有 ws-a 会命中 |
| `session`（无 target） | 任何会话 | `s:<id>:<sessionId>` ——每个会话各跑各的 |
| `session`（`target: ses-1`） | 只在 ses-1 里 | 同上，且只有 ses-1 会命中 |

可见性与实例的判定都在**宿主侧**完成：客户端只上报自己正在渲染的 `sessionId`，宿主据此解析它所属的 workspace（`workspaceRegistry`），过滤出可见按钮并算好 `instanceKey`。因此两个界面（会话头部 + 侧边栏）看到的是同一份事实；对同一个共享实例，第二次点击是**加入**正在运行的那次执行，而不是再起一个。

## 执行与输出

- 命令通过 `ctx.shell` 执行（`onExpiry: 'none'`，无内建超时）；宿主从句柄的**非消费式** `observed.stdout/stderr` reader 按 `pollMs`（默认 150ms）泵入内存缓冲，`done` 落定时按退出码判定 `completed` / `failed` / `killed`。
- 每个实例只保留**最新一次**运行；输出超过 `maxOutputChars`（默认 200000）时从头部裁剪并留下 `…[earlier output dropped]` 标记，裁掉的字符数回传给界面。
- 界面侧：点按钮 = 运行（或加入共享实例）并弹出 **popover**，700ms 轮询实时输出、贴底自动滚动；「⤢」一键放大到 `shell.overlay` 里的**大面板**，长输出更舒展。运行中可 Stop，结束后可 Run again；Esc 关闭，点外面也关闭。
- `ctx.shell` 缺失时运行请求返回 `shell-unavailable`（503），原因会显示在 popover 里，插件本身照常加载。

## 依赖的 DSH 接口

这几处接口没有类型约束，升级 DSH 时值得复查：

- **槽位**：`ctx.slots.inject(key, () => ctx.slots.register(spec, Component))`，注册进 `conversation.session.header.actions`（session 作用域，组件收 `sessionId` prop）、`sidebar.footer.action`（root 作用域，自己从 `sessions.list.getSnapshot()` 里取 `retainedBy.mainView > 0` 的行）与 `shell.overlay`。三个注入各自 try/catch：某个槽位缺席只失去对应界面，不拖垮插件。
- **路由**：`webServer.register({ kind: 'exact', path, handler })`，且 (kind, path) **重复注册会抛错**——所以 `GET/POST /quick-actions/run` 与 `GET/POST /quick-actions/config` 各自在一个 handler 里按 `request.method` 分发，而不是注册两次。
- **workspace**：`ctx.get('workspaceRegistry').list()` 返回实体，用 `entity.sessionIds` 反查会话所属 workspace，取 `entity.id` / `entity.path`。服务缺席时会话视为未分组（workspace 相关 target 不命中，无 target 的照常可见）。
- **shell**：`ctx.shell.resolve(request)` → `ctx.shell.execute(spec)`，读输出走 `exec.observed[channel].readFrom(offset)`（`{ text, nextOffset, lossy }`），`exec.done` 只 resolve 不 reject。
- **客户端服务**：`slots` / `sessions` / `workspaces`（配置面板的 workspace 下拉：`workspaces.list.getSnapshot().items`）/ `locale`（`ctx.locale.register(NS, { zh, en })`，缺席时回退到按 `navigator.language` 选的内置词典）。全部可选，缺席即降级。

## 安装

见仓库根 [README](../README.md)。插件名 `dsh-quick-actions`，加进 `package.json` 的 `dsh.profile.bundles` 即可；浏览器半声明的注入包是 `dsh-client-locale`、`dsh-client-ui-sidebar`、`dsh-client-ui-workspace`、`dsh-client-ui-conversation`、`dsh-client-ui-layout`。

需要 profile 里挂有 shell 执行器（默认 profile 的 `dsh-tool-bash` 会带上 `dsh-bash-local`），否则按钮点下去只会得到 `shell-unavailable` 提示。

`cordis.patch.yml` 中插件行可选的 `config`：

```yaml
- id: dsh-quick-actions
  name: 'dsh-quick-actions'
  config:
    workdir: /Users/you/projects     # 命令默认工作目录
    storePath: /custom/path.json     # 按钮 store 路径
    maxOutputChars: 200000           # 单次运行保留的输出上限
    pollMs: 150                      # 输出泵间隔
    buttons:                         # 静态按钮（面板只读）
      - id: status
        label: Git status
        command: git -C {workspace} status -sb
        scope: workspace
```

## 测试

```bash
cd dsh-quick-actions
node test/run.mjs      # Host 半：scope 可见性/实例共享、执行生命周期、占位符、输出裁剪、store 校验与持久化
node test/client.mjs   # 浏览器半：槽位注册、按钮拉取、运行与 popover 输出、放大面板、「+」配置面板增删保存、失败提示、Esc
```

覆盖：三种 scope × 有无 target 的可见性矩阵（含未分组会话、无会话上下文）、全局/按 workspace/按会话三种实例键的共享与隔离、启动-加入-泵输出-落定-停止的完整链路、shell 缺失与不可见按钮的拒绝、`{workspace}`/`{session}` 展开与保留、超上限从头部裁剪、config 端点对 id/label/scope/预留 id 的校验、写盘与重启回读、删除按钮时清理其运行记录；客户端在打桩的 `window.__ModuleLoader__` 下装配，覆盖三个槽位注册、字典注册、按会话拉取、点击运行后 popover 的实时输出、Expand/Esc、配置面板从建条目到保存落盘、启动失败原因回显、侧边栏跟随当前会话切换。

## 卸载

从 `dsh.profile.bundles` 移除 `dsh-quick-actions` 条目、删除 `dependencies` 中的条目与 `node_modules/dsh-quick-actions` 目录，重启 `dsh web`；`cordis.patch.yml` 中的插件行可一并删除。按钮 store（JSON 文件）不会被自动删除，确认不需要后手动清理。
