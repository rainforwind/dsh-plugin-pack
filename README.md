# dsh-plugin-pack

DSH 插件集合。每个插件在独立子目录中，可独立安装使用。

## 插件列表

| 插件 | 说明 |
|------|------|
| [dsh-task-badge](./dsh-task-badge/) | Favicon + 侧边栏：运行中/未读任务计数 |

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

## 开发规范

- `main` 分支：所有插件的稳定版本
- 开发新插件或修改现有插件：从 `main` 拉分支
- 每个插件是独立的 DSH bundle，有自己的 `package.json`、`cordis.patch.yml`
- 插件间无依赖关系
