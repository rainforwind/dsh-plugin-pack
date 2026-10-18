# dsh-plugin-pack

DSH 插件集合。每个插件在独立子目录中，可独立安装使用。

## 插件列表

| 插件 | 说明 |
|------|------|
| [dsh-task-badge](./dsh-task-badge/) | Favicon + 侧边栏：运行中/未读任务计数 |
| [dsh-quick-actions](./dsh-quick-actions/) | 快捷操作按钮：执行 shell 命令并实时看输出，可按会话/workspace/全局定义 scope |
| [dsh-lan-proxy](./dsh-lan-proxy/) | 按 IP 白名单把回环 Web GUI 反代到局域网/Tailscale（独立监听 + 来源校验，Settings 面板直接编辑、保存即重绑；需 dsh >= 0.1.7） |
| [dsh-session-manager](./dsh-session-manager/) | 已归档会话管理：归档会话行菜单新增「删除…」永久删除入口，并提供 `session_delete` agent 工具（仅限已归档、未运行的会话，Host 端强制校验） |

## 安装单个插件

```bash
cd ~/.dsh/profiles/web
npm install github:rainforwind/dsh-plugin-pack#subdirectory=dsh-task-badge
```

或克隆后手动复制：

```bash
git clone https://github.com/rainforwind/dsh-plugin-pack.git
cp -r dsh-plugin-pack/dsh-task-badge node_modules/
```

然后在 `package.json` 的 `dsh.profile.bundles` 中添加插件名。

### 本地开发用 `link:`，不要复制

上面的 `cp -r` 是**复制快照**：之后修改本仓库源码不会同步到 profile，容易出现「桌面 profile 有、web profile 没有」或「改了代码但页面没变」。

本地开发时改用 `link:`（以 `dsh-task-badge` 为例）：

```bash
dsh plugin --profile web add link:/绝对路径/dsh-plugin-pack/dsh-task-badge
dsh plugin --profile desktop add link:/绝对路径/dsh-plugin-pack/dsh-task-badge
```

`link:` 会在 profile 的 `node_modules` 里放一个指向工作区的软链；之后再改 `lib/` 或 `client/`，Host 侧重载/重启、Client 侧刷新页面即可，不需要重新安装。工作区别移动或改名，否则绝对路径 link 会失效。

## 开发规范

- `main` 分支：所有插件的稳定版本
- 开发新插件或修改现有插件：从 `main` 拉分支
- 每个插件是独立的 DSH bundle，有自己的 `package.json`、`cordis.patch.yml`
- 插件间无依赖关系
