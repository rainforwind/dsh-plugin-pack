# dsh-quick-actions

在 DSH 界面上植入**快捷操作按钮**：点击执行一条 shell 命令，执行中/执行后都能实时查看输出；按钮的作用范围（scope）与运行实例的共享方式均可自定义——全局、某个 workspace、或某个会话。

按钮渲染在两处：**会话头部**（`conversation.session.header.actions`，跟随当前会话）与**侧边栏底部**（`sidebar.footer.action`，任何界面常驻）。两处末尾都有一个「+」按钮，唤起配置面板。

## 按钮定义从哪来

两层来源，合并展示：

| 来源 | 写在哪 | 可否在面板里改 |
|------|--------|----------------|
| 静态定义 | `cordis.patch.yml` 里插件行的 `config.buttons` | 只读（面板中灰底展示） |
| 运行时定义 | 「+」面板增删改，落盘到 JSON store | 可以 |

JSON store 的位置按下面的顺序解析，**第一个有值的生效**（面板里的「存储位置」直接展示这份链，并标出当前生效的那条）：

| 顺序 | 来源 | `storeSource` |
|---|---|---|
| 1 | `cordis.patch.yml` 的 `config.storePath`（管理员固定，面板不可改） | `config` |
| 2 | 面板里设定的路径（存于 `<profileContext.dir>/dsh-quick-actions.settings.json`） | `panel` |
| 3 | 正在运行的 profile：`<profileContext.dir>/dsh-quick-actions.json` | `profile` |
| 4 | `$DSH_PROFILE_DIR/dsh-quick-actions.json`（仅兼容旧宿主） | `env` |
| 5 | `~/.dsh/dsh-quick-actions.json` | `home` |

`$DSH_PROFILE_DIR` 描述的是**启动者的**会话——从别的 profile 的 shell 里拉起的宿主会继承它——所以只能当兼容兜底，不能当持久数据目录，那正是「按钮全部消失」的原因。

从旧位置升级上来时，profile 目录里的文件还不存在，此时**只读**一次 `~/.dsh/dsh-quick-actions.json` 让按钮仍然可见；第一次保存直接写到解析出的路径，旧文件原样保留作为回滚依据。

面板改路径是**即时生效**的：宿主就地重新解析并把当前 store 切过去，不需要重启，下一次保存就落到新位置。`config.storePath` 一旦在 patch 里写了，面板会把该行标为固定并隐藏输入框——一个赢不了的控件不如没有。写入一律「临时文件 + rename」；校验失败的条目连同字段名一起回给面板，不会半写。

一条定义的字段：

```yaml
- id: clean          # 必填，小写字母/数字/- _ . ，全列表唯一（config 里的 id 预留）
  label: Clean       # 必填，按钮文字
  icon: '🧹'         # 可选，1-8 字符（emoji）
  command: rm -rf {workspace}/dist   # 必填；支持 {workspace}、{session} 占位符
  workdir: /srv/app  # 可选；缺省时依次取 config.workdir → workspace 目录
  sandbox: inherit   # 可选；inherit | read-only | workspace-write | danger-full-access
  scope: workspace   # global | workspace | session，默认 global
  target: ws-a       # 可选，钉死到某个 workspace id / session id
  params:            # 可选，运行时参数（最多 8 个）
    - name: count    # 必填，[A-Za-z][A-Za-z0-9_]{0,31}，全按钮唯一
      required: true # 默认 true；false 即可选
      default: '5'   # 可选，预填值；必填参数缺省时以默认值兜底
```

`{workspace}` / `{session}` 在事实已知时展开（workspace 目录、当前会话 id），未知时**保留字面量**——占位符没被展开必须看得见，而不是静默变成空串。

## 参数（带参执行）

一条定义的 `params` 把「输入框的集合」声明给按钮：

- **定义**在「+」管理面板的 Parameters 区：每行填名称、默认值、勾「必填」，可增删（上限 8 个）。名称非法/重复在保存前就被拦下。
- **取值**在按钮卡片（popover / 放大模态）里：每个参数渲染一行输入框，必填项带红色星号。**默认值以灰色 placeholder 呈现、不预填进输入框**——空的框就是空的，所以你填的和默认建议一眼能分开，悬停可看完整默认值。
- **点击即运行**：点芯片不会先弹卡片拦一道，而是按「卡片里填过的值 → 缺省值 → 字面量」解析后直接执行，卡片随后打开显示输出。卡片里改过的值会**记住**（按运行实例），下次点芯片复用；要看或改参数点右侧箭头（折叠侧栏下点芯片即打开放大模态）。
- **执行**时 `{name}` 占位符替换成提交的值——先展开 `{workspace}`/`{session}`，再替换参数；未提交（或提交空串）且无默认值的占位符**保留字面量**。请求里不属于该按钮 `params` 的键一律丢弃（陈旧客户端无法注入任意占位符）。
- 实例键与参数无关：同一个共享实例（global/workspace）**带不同的参数值仍是同一次运行**（第二次点击是加入），运行记录回显当次使用的参数值。

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
- **workspace**：`ctx.get('workspaceRegistry').list()` 返回实体，用 `entity.sessionIds` 反查会话所属 workspace，取 `entity.id` / `entity.path`。这个 getter **已被持久化的 header 索引过滤**，所以刚建的会话还不在任何列表里——此时退回 `workingDirectory.get(agent.session)` 拿它自己的目录，再按目录前缀匹配 workspace；仍匹配不上就把该目录当作 `{workspace}`。这一步是必要的：`workdir` 为空串时 `ctx.shell.resolve()` 会退到 `process.cwd()`（dsh 进程的启动目录，见 `dsh-bash-local` 的 `resolve` 契约），命令就会跑在会话目录之外——`{workspace}` 也展不开。未分组会话的实例键带上会话 id（`w:<id>:~<sessionId>`），避免多个无 workspace 的会话共用一次运行。服务缺席时会话视为未分组（workspace 相关 target 不命中，无 target 的照常可见）。
- **agents**：`ctx.get('agents').get(sessionId)` 取活着的 agent，用于把 id 换成 `workingDirectory.get()` 需要的 session 对象；没有活 agent 时跳过这层兜底。
- **shell**：`ctx.shell.resolve(request)` → `ctx.shell.execute(spec)`，读输出走 `exec.observed[channel].readFrom(offset)`（`{ text, nextOffset, lossy }`），`exec.done` 只 resolve 不 reject。
- **sandboxPolicy**：`ctx.get('sandboxPolicy').resolve()` 给出部署默认的 `mode`。**快捷按钮是没有 session 的 agentless 调用**，这类调用的 `workspace-write` 根取部署兜底（默认 `process.cwd()`，即宿主启动目录 profile dir），于是 `.git` 锁文件写不进去、`git commit` 报错——即使命令其实跑在仓库里。所以这里在 `shell.resolve()` **之后**用 `spec.workdir`（已含全部兜底）作为 `workspaceRoot`，模式默认沿用部署值，按钮可用 `sandbox` 显式覆盖。根必须是绝对路径（策略服务会校验），故 `resolve(spec.workdir)`。没有该服务时不注入策略，行为与旧版一致。
- **客户端服务**：`slots` / `sessions` / `workspaces`（配置面板的 workspace 下拉：`workspaces.list.getSnapshot().items`）/ `locale`（`ctx.locale.register(NS, { zh, en })`，缺席时回退到按 `navigator.language` 选的内置词典）。全部可选，缺席即降级。
- **timer（硬依赖）**：客户端半区跑在受限 context 上，`ctx.interval` 只对声明了 `inject: ['slots', 'timer', 'locale']` 的 fiber 放行——未声明就调用是同步抛错，会让整个页面启动失败（`web boot: N entries did not activate / dsh-quick-actions: failed`）。3s 上下文轮询与 popover 的 700ms 轮询都走 `ctx.interval`，所以 `timer` 必须留在 inject 里，不能当可选项。
- **locale（同等重要）**：受限 context 上 `ctx.get('locale')` 只对声明过的服务返回东西。`locale` 不在 `inject` 里时字典注册静默不执行，槽位规范里的 `locale: NS` 仍会让宿主传一个 `t`，但它解析不了我们的命名空间、把 key 原样吐回来——界面就会出现 `pop.rerun`、`status.exit0` 这种字面量。所以 `locale` 必须在 `inject` 里，并且组件侧再兜一层：宿主 `t` 返回的字符串等于 key 时改用本地词典，任何情况下都不让原始 key 上屏。

## 安装

见仓库根 [README](../README.md)。插件名 `dsh-quick-actions`，加进 `package.json` 的 `dsh.profile.bundles` 即可；浏览器半声明的注入包是 `dsh-client-locale`、`dsh-client-ui-sidebar`、`dsh-client-ui-workspace`、`dsh-client-ui-conversation`、`dsh-client-ui-layout`。

需要 profile 里挂有 shell 执行器（默认 profile 的 `dsh-tool-bash` 会带上 `dsh-bash-local`），否则按钮点下去只会得到 `shell-unavailable` 提示。

`cordis.patch.yml` 中插件行可选的 `config`：

```yaml
- id: dsh-quick-actions
  name: 'dsh-quick-actions'
  config:
    workdir: /Users/you/projects     # 命令默认工作目录
    storePath: /custom/path.json     # 覆盖默认位置（默认 $DSH_HOME/profiles/<name>/, 建议绝对路径）
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

覆盖：三种 scope × 有无 target 的可见性矩阵（含未分组会话、无会话上下文）、全局/按 workspace/按会话三种实例键的共享与隔离、启动-加入-泵输出-落定-停止的完整链路、shell 缺失与不可见按钮的拒绝、`{workspace}`/`{session}` 展开与保留、超上限从头部裁剪、config 端点对 id/label/scope/预留 id 的校验、写盘与重启回读、删除按钮时清理其运行记录；参数：必填缺失在 shell 启动前拒绝（400 `missing-param:<name>`）、值替换与回显、未知参数键丢弃、定义经 config 落盘往返、非法/重名参数的字段级报错；客户端在打桩的 `window.__ModuleLoader__` 下装配，覆盖三个槽位注册、字典注册、按会话拉取、点击运行后 popover 的实时输出、Expand/Esc、配置面板从建条目到保存落盘、启动失败原因回显、侧边栏跟随当前会话切换；参数：带参按钮点芯片即运行并复用卡片里填过的值、默认值以 placeholder 呈现、卡片填值后 POST 携带 `params`、管理面板可声明参数行、保存后重开参数仍在；以及新建会话（尚未进 header 索引）按自身目录解析 workspace、未分组会话实例不互相串味；store 位置：profile 优先于被污染的 `DSH_PROFILE_DIR`、无 `profileContext` 时走 env、显式 `storePath` 最高优先、profile 文件缺失时只读 legacy 且首次保存写 profile 路径、profile 文件存在时不合并 legacy；沙箱：策略根跟随按钮 workdir（缺省则跟随 shell cwd）、按钮可显式放宽、只读部署不被悄悄放宽、无策略服务时不注入、非法模式被拒并往返保存；面板：候选链渲染与生效项标记、面板覆盖即时切换并落盘到 settings、清除覆盖回到 profile、被 patch 固定时隐藏输入框、危险路径被拒；宿主 `t` 解析不了命名空间时界面不漏出原始 locale key。

## 卸载

从 `dsh.profile.bundles` 移除 `dsh-quick-actions` 条目、删除 `dependencies` 中的条目与 `node_modules/dsh-quick-actions` 目录，重启 `dsh web`；`cordis.patch.yml` 中的插件行可一并删除。按钮 store（JSON 文件）不会被自动删除，确认不需要后手动清理。
