# dsh-quick-actions：按钮 store 路径改为「按正在运行的 profile」解析

> **给接手的 agent 的一句话**：把 `defaultStorePath()` 从 `process.env.DSH_PROFILE_DIR` 改为优先读 Cordis 的 `profileContext` 服务，并加一条只读的旧位置回退；补 6 个用例，同步 README 与 patch 注释。文件、行号、验收命令见 §6–§8。

- 仓库：`/Users/zhou/workspace/dsh-plugin-pack/dsh-quick-actions`
- 现状版本：1.0.0（本地 `link:` 包，无构建步骤，改完重启宿主即生效）
- 影响文件：`lib/index.js`、`test/run.mjs`、`README.md`、`cordis.patch.yml`

---

## 1. 事故背景

2026-10-25，web profile 里"定义好的 quick actions 全部消失"，按钮数据其实没丢（`~/.dsh/dsh-quick-actions.json`，10-17 修改，4 个按钮 `Git / git push / time / run`），是插件读错了文件。

时间线：

| 时间 | 动作 | 结果 |
|---|---|---|
| 12:12 | 宿主从普通终端启动 `dsh web` | 进程环境干净，`DSH_PROFILE_DIR` 未设置 |
| 14:19 | 从 **DSH desktop 会话的 shell** 里重启 `dsh web` | 宿主继承了 `DSH_PROFILE_DIR=/Users/zhou/.dsh/profiles/desktop` |
| 16:26 | plugin market 卸载插件后自动重启宿主 | 原样继承上面那份 env（`env: process.env`） |
| 16:31 | 打开页面 | 按钮为空 |

现场证据（对运行中的宿主直接请求）：

```console
$ curl -s -b cookie 'http://127.0.0.1:3080/quick-actions/config'
{"ok":true,"buttons":[],"configButtons":[],
 "storePath":"/Users/zhou/.dsh/profiles/desktop/dsh-quick-actions.json"}   # ← 不存在

$ ls ~/.dsh/profiles/desktop/dsh-quick-actions.json
No such file or directory

$ ls ~/.dsh/dsh-quick-actions.json
-rw-r--r--  1020  Oct 17 11:44    # ← 真实数据在这里
```

临时止血：用干净环境重启宿主（只保留 `DSH_HOME`）后，`storePath` 回到 `~/.dsh/dsh-quick-actions.json`，4 个按钮恢复。**这只是止血，代码里的洞还在。**

---

## 2. 根因

三层叠加，任何一层修掉都能避免复发；本单修第 2 层，第 3 层另开 issue（§10）。

### 2.1 宿主不会声明"自己是哪个 profile"

用干净终端启动的 `dsh web`（即 `--profile web`）宿主，实测环境里**只有 `DSH_HOME`**，没有 `DSH_PROFILE_DIR`。这个变量是 dsh 给 **bash 工具调用**准备的（"每个 profile 启动的 Harness 的 shell 调用里都会设置"），它描述的是**启动者**的环境，不是宿主自己；宿主从 DSH 会话的 shell 里被拉起时，继承的就是那个会话的 profile。

### 2.2 插件拿会话级环境变量当持久数据目录（本单要修的）

```js
// lib/index.js:41-45
function defaultStorePath() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) return join(profileDir, 'dsh-quick-actions.json')
  return join(homedir(), '.dsh', 'dsh-quick-actions.json')
}
```

而 dsh **已经**通过服务把权威事实给了宿主：

```ts
// @deepseek-ai/dsh-app-boot/lib/types/profile-context.d.ts:10-14
export interface ProfileContext {
  readonly name: string;   // 例如 "web"
  readonly dir: string;    // <DSH_HOME>/profiles/<name>
  readonly patchPath: string;
  readonly home: string;
  // …
}
```

```js
// @deepseek-ai/dsh/lib/profile-boot-*.js:304
hostCtx.provide("profileContext", profileContext)
```

插件现在只 `inject = ['webServer']`，但已经用 `ctx.get('workingDirectory')` / `ctx.get('agents')` / `ctx.get('shell')` 这种可选服务读取方式，读 `profileContext` 不需要改 `inject` 列表。

### 2.3 重启机制原样继承 env（放大器，不在本仓库）

```js
// dshmarket/lib/recovery.js:372（restart.js:553 同理）
child = spawn(config.spawn.file, config.spawn.args, {
  cwd: config.cwd, detached: config.spawn.detached,
  stdio: [...], env: process.env,   // ← 不增不减
  shell: config.spawn.viaShell,
})
```

市场知道正确的 `profileDir`（写在 recovery 记录里），但选择整份继承。结果：**一次错误启动被重启固化**，之后每次市场重启都复制同一个错误 env。

---

## 3. 目标与非目标

**目标**

1. store 的物理位置只由「正在运行的 profile」和显式 `config.storePath` 决定，与启动者的 env 无关。
2. 不丢已有按钮：旧位置的数据在升级后第一次启动仍然可见。
3. 兼容旧宿主（没有 `profileContext` 的 dsh 版本）与显式 `storePath` 用户。
4. 可观测：日志与 `/quick-actions/config` 能说明"为什么是这个路径"。

**非目标**

- 不改 dshmarket / dsh 本体（§10 单独提）。
- 不改 store 文件格式、不改校验规则、不改 UI。
- 不做跨 profile 的同步或合并。

---

## 4. 方案

### 4.1 解析顺序

| 优先级 | 来源 | 路径 | `source` |
|---|---|---|---|
| 1 | `config.storePath`（非空字符串，支持前导 `~/`） | 原样（展开 `~`） | `config` |
| 2 | `ctx.get('profileContext')?.dir` | `<dir>/dsh-quick-actions.json` | `profile` |
| 3 | `process.env.DSH_PROFILE_DIR`（仅为兼容旧宿主） | `<env>/dsh-quick-actions.json` | `env` |
| 4 | 兜底 | `~/.dsh/dsh-quick-actions.json` | `home` |

```js
// 新增，替换 defaultStorePath()
function resolveStore(ctx, config) {
  const explicit = typeof config.storePath === 'string' ? config.storePath.trim() : ''
  if (explicit) return { path: expandHome(explicit), source: 'config' }

  const profile = ctx.get('profileContext')
  if (profile && typeof profile.dir === 'string' && profile.dir.trim()) {
    return { path: join(profile.dir, 'dsh-quick-actions.json'), source: 'profile' }
  }

  const envDir = (process.env.DSH_PROFILE_DIR || '').trim()
  if (envDir) return { path: join(envDir, 'dsh-quick-actions.json'), source: 'env' }

  return { path: join(homedir(), '.dsh', 'dsh-quick-actions.json'), source: 'home' }
}
```

`expandHome(p)`：仅处理 `p === '~'` 与前缀 `'~/'`，其余原样；不做相对路径解析（保持现有"按宿主 cwd 解析相对路径"的隐含行为，文档写明建议绝对路径）。

### 4.2 迁移：只读回退，不搬运

升级后第一次启动，`source=profile` 指向的文件通常还不存在；此时允许**读**一次旧位置，但**绝不写**：

- 触发条件：解析结果来自 `profile`（即用户没写 `storePath`）**且**目标文件不存在；
- 回退来源只有 `~/.dsh/dsh-quick-actions.json`（**不包含 `DSH_PROFILE_DIR` 那条路**——那正是错误的来源，读它等于把别的 profile 的按钮搬进来）；
- 读到就加载，日志一行：
  `[quick-actions] store: legacy ~/.dsh/dsh-quick-actions.json is visible; first save writes <resolved>`
- 第一次 `POST /quick-actions/config` 时正常写到解析路径（`persistStore()` 已有 `mkdirSync` + 临时文件 + rename）；
- 旧文件保持不动，作为回滚依据；
- 幂等：目标文件一旦存在，不再回退。

```js
// 伪代码：loadStore() 内，existsSync(storePath) 为 false 的分支
if (source === 'profile') {
  const legacy = join(homedir(), '.dsh', 'dsh-quick-actions.json')
  if (existsSync(legacy)) {
    console.log(`[quick-actions] store: legacy ${legacy} is visible; first save writes ${storePath}`)
    return readButtons(legacy)          // 把现有 JSON.parse + validateList 抽成 readButtons(path) 复用
  }
}
return []
```

### 4.3 可观测

- `apply()` 里一条日志：`[quick-actions] store: <path> (source=<config|profile|env|home>)`。
- `GET /quick-actions/config` 响应**增加** `storeSource` 字段（`storePath` 不变）。客户端当前只读 `storePath`，未知字段无害（`client/client.js:435`）。

### 4.4 边界

| 情况 | 行为 |
|---|---|
| 无 `profileContext`（旧 dsh / 测试桩） | 走 `env` → `home`，与今天一致 |
| `profileContext.dir` 为空串 | 视为不可用，继续下一条 |
| `config.storePath` 为相对路径 | 原样使用（与今天一致），文档注明推荐绝对路径 |
| 目标目录不存在 | `persistStore()` 已 `mkdirSync(recursive)`，无需新逻辑 |
| 多宿主同 profile | 共用同一文件（与今天一致） |
| 文件损坏/校验失败 | 现有行为：日志 + 空列表，不覆盖原文件 |
| Windows | 全部走 `node:path` 的 `join`，无硬编码分隔符 |

---

## 5. 备选方案与取舍

| 方案 | 做法 | 评价 |
|---|---|---|
| A | 只在 profile 的 `cordis.patch.yml` 写死 `storePath` | 一行止血，但每个 profile 都要写；插件仍是坑，不采纳为最终方案（可作为过渡） |
| **B（推荐）** | `profileContext` 优先 + 旧位置只读回退 | 修在根上；兼容旧宿主与显式配置；不丢数据 |
| C | 默认永远用 `~/.dsh/dsh-quick-actions.json`（忽略 env） | 行为变化最小，但违背插件现有的 per-profile 语义，多 profile 无法隔离 |
| D | 插件去修正宿主 env | 做不到：env 由启动者/重启者决定 |

选 B。理由：dsh 已经提供了权威事实（`profileContext`），插件此前只是没接；接上后，无论宿主怎么被启动、被谁重启，位置都只跟"正在运行哪个 profile"有关。

---

## 6. 落地清单

### `lib/index.js`

| 位置 | 改动 |
|---|---|
| `:41-45` `defaultStorePath()` | 删除，替换为 `resolveStore(ctx, config)`（§4.1）+ `expandHome()` |
| `:127` `apply(ctx, config)` | 保留签名；`:134-136` 改为 `const { path: storePath, source } = resolveStore(ctx, config)`，并打印 `store:` 日志 |
| `:151-165` `loadStore()` | 目标文件不存在且 `source === 'profile'` 时，读 `~/.dsh/dsh-quick-actions.json` 回退（§4.2）；抽出共用解析函数避免复制粘贴 |
| `:592-601` `GET /quick-actions/config` | 响应加 `storeSource: source` |
| `:599` `storePath` | 不变（仍返回解析后的绝对路径） |

注意：

- **不要**把 `profileContext` 加进 `inject` 数组（那会把插件变成"必须有该服务"）；沿用 `ctx.get('profileContext')` 的可选读取，与现有 `workingDirectory` / `agents` 一致。
- `defaultStorePath` 删除后不要留死代码；如果有外部引用，改名为 `resolveStore` 并更新调用点。
- `persistStore()` 不需要改：它已经写 `storePath`，而 `storePath` 现在是解析结果。
- `client/client.js` 不需要改：它只回显 `storePath`（`:435`、`:1335`），`storeSource` 属于可选展示，不阻塞本单。
- 建议提交信息：`fix(store): resolve the button store from profileContext, not the launcher env`。

### `test/run.mjs`

- `makeHost()`（`:70`）增加 `profileContext` 选项，并在 `ctx.get` 分支返回它；默认 `undefined`（保持现有用例行为）。
- 新增用例见 §8；`process.env.DSH_PROFILE_DIR` 与 `HOME` 的读写必须 `try/finally` 还原。

### 文档

- `README.md:16`：把"默认路径 `$DSH_PROFILE_DIR/…`"改为"默认 `<profileContext.dir>/…`（即 `$DSH_HOME/profiles/<name>/…`）；无该服务时回退 `$DSH_PROFILE_DIR`，再回退 `~/.dsh/…`；旧位置的数据会在首次保存前只读可见"。
- `README.md:92-93`：示例注释同步。
- `cordis.patch.yml:4-6`：同上。
- 版本 `1.0.0 → 1.0.1`（`package.json`）。

---

## 7. 验收标准

- [ ] **AC1（事故回归）** `profileContext.dir=/tmp/p1` 且 `DSH_PROFILE_DIR=/tmp/p2`（`p2/dsh-quick-actions.json` 里有按钮）→ `/quick-actions/config` 的 `storePath` 为 `/tmp/p1/…`、`storeSource === 'profile'`、按钮**不来自** p2。
- [ ] **AC2（兼容）** 无 `profileContext`、`DSH_PROFILE_DIR=/tmp/p2` → `storePath=/tmp/p2/…`、`source === 'env'`。
- [ ] **AC3（显式优先）** `config.storePath=/tmp/explicit.json` 时，忽略 profile/env/home。
- [ ] **AC4（回退可见）** p1 无文件、`~/.dsh/dsh-quick-actions.json` 有按钮 → 按钮可见；`storePath` 仍报 p1；日志出现 legacy 提示。
- [ ] **AC5（落盘位置）** 在 AC4 状态下 `POST /quick-actions/config` → p1 文件生成且内容正确；`~/.dsh/dsh-quick-actions.json` 字节不变。
- [ ] **AC6（幂等）** p1 已有文件时不再读 legacy（即便 legacy 内容不同）。
- [ ] **AC7（回归）** `node test/run.mjs` 与 `node test/client.mjs` 全绿。
- [ ] **AC8（真实环境）** 重启 web profile 后 `GET /quick-actions/config` 返回 `storePath=/Users/zhou/.dsh/profiles/web/dsh-quick-actions.json`，页面显示 `Git / git push / time / run`。

---

## 8. 测试计划

命令（无构建步骤）：

```bash
cd /Users/zhou/workspace/dsh-plugin-pack/dsh-quick-actions
node test/run.mjs
node test/client.mjs
```

新增用例（沿用 `test/run.mjs` 的 `test(label, fn)` 风格）：

| # | 构造 | 断言 |
|---|---|---|
| 1 | `profileContext.dir=/tmp/p1`，`DSH_PROFILE_DIR=/tmp/p2`，p2 文件有按钮 | `storePath` 指向 p1；`buttons=[]`（不回退到 p2） |
| 2 | 同上，但 p1 文件也存在（有按钮 A）、p2 有按钮 B | 只读到 A |
| 3 | 无 `profileContext`，`DSH_PROFILE_DIR=/tmp/p2` | 读到 p2（旧行为） |
| 4 | `config.storePath=<tmp>/x.json`，profile 与 env 都在 | 读写都落 `x.json` |
| 5 | p1 不存在，`HOME=<tmp>` 且 `<tmp>/.dsh/dsh-quick-actions.json` 有按钮 | 按钮可见；`storePath` 报 p1；`POST` 后 p1 出现、legacy 未变 |
| 6 | p1 已存在，legacy 存在且按钮不同 | 只读 p1（幂等，不合并） |

手工矩阵（真实宿主）：

| 启动方式 | 期望 |
|---|---|
| 干净终端 `cd ~ && dsh web` | `storePath=profiles/web/…`，按钮可见 |
| 从 desktop 会话的 shell 启动（`DSH_PROFILE_DIR` 污染） | 同 profile 结果，不受污染 |
| plugin market 重启 | 同上 |
| 显式 `storePath` | 该路径 |
| 旧宿主（无 `profileContext`） | 走 env/home，行为不变 |

---

## 9. 风险与回滚

- **数据迁移是"读旧写新"**：升级后第一次保存会把数据写到 profile 目录，`~/.dsh/dsh-quick-actions.json` 保留不动；要回滚就把 `lib/index.js` 还原，旧文件还在，按钮照常。
- **多 profile 首次升级都会读到同一份 legacy**（只读）。各自保存后分叉，这是符合 per-profile 语义的结果；如果用户希望共享，写显式 `storePath`。
- **旧宿主兼容**：没有 `profileContext` 时退回 env，行为与今天一致，不会更糟。
- 风险等级：低（单文件、无协议变更、响应字段只增不改）。

---

## 10. 相邻问题（不同仓库，建议单独提）

**dshmarket 重启继承会话身份**。它知道 `config.profileDir`，却在 spawn 时整份继承 `process.env`，导致"上一个宿主的会话变量"被下一任继承。建议：

```js
// dshmarket/lib/recovery.js:372（restart.js:553 同步）
const env = { ...process.env }
env.DSH_PROFILE_DIR = config.profileDir      // 已知的权威值
delete env.DSH_PROFILE                        // 会话级，不该继承
delete env.DSH_SESSION_ID
delete env.DSH_WEB_URL
delete env.DSH_SHELL
```

理由：重启出来的宿主是**同一 profile 的新宿主**，不是"上一个会话的延续"；把这些变量归一化，所有用 `DSH_PROFILE_DIR` 定位数据的第三方插件都会一起受益。

（dsh 本体是否该在宿主进程里自设 `DSH_PROFILE_DIR`，是更上游的设计讨论，本单不做。）

---

## 附录 A：现场证据

```console
$ ps eww -p <host> | tr ' ' '\n' | grep ^DSH_
DSH_HOME=/Users/zhou/.dsh          # 干净宿主的全部 DSH 变量

$ curl -s -b cookie http://127.0.0.1:3080/quick-actions/config
{"ok":true,"buttons":[],"configButtons":[],
 "storePath":"/Users/zhou/.dsh/profiles/desktop/dsh-quick-actions.json"}

$ ls -l ~/.dsh/dsh-quick-actions.json
-rw-r--r-- 1020 Oct 17 11:44     # 4 个按钮：Git / git push / time / run
```

## 附录 B：环境事实

- `ProfileContext`（`@deepseek-ai/dsh-app-boot`）由 dsh 在 profile 引导时 `hostCtx.provide("profileContext", …)`，**只在 profile 启动的宿主里存在**。
- 插件当前 `inject = ['webServer']`；`workingDirectory` / `agents` / `workspaceRegistry` / `shell` 均为 `ctx.get(...)` 可选读取，`profileContext` 照此办理。
- store 写入已是原子替换（临时文件 + rename，`lib/index.js:167-173`），本单不需要动。
