# dsh-lan-proxy

把只监听 `127.0.0.1` 的 DSH Web GUI 按 IP 白名单开放给局域网 / Tailscale 设备的反向代理插件。

DSH 出于安全考虑只在回环地址提供 Web 服务，`dsh web --host 0.0.0.0` 被刻意拒绝。本插件不改动原有的监听与任何其他插件的组合行，而是**另开一道门**：

```
局域网/Tailscale 设备 ──▶ dsh-lan-proxy（独立 host:port + 来源 IP 白名单）
                              │  Host/Origin 重写为回环权威
                              ▼
                        127.0.0.1:<web 端口>（原有 Web 服务，行为不变）
```

- **来源白名单**：只放行 `allow` 里**显式配置**的 IP / CIDR（支持 IPv4/IPv6 单地址与网段），不预置任何默认 IP 或网段；回环来源始终放行（本机本来就能直连）。
- **协议全支持**：普通 HTTP、SSE（`/api` 的事件流）、WebSocket 升级（`/api/remote.mux`）全部转发。
- **零侵入**：只消费 `webServer` / `connection` 两个服务，不注册任何路由、不改写任何别人的组合行，卸载即消失。
- **热配置**：配置即本插件组合行的 `config`（`cordis.patch.yml` 或 Settings 页面），保存后 dsh 重启该行、代理立刻按新配置重绑，无需重启 `dsh web`。
- **版本**：需要 dsh >= 0.1.7（配置段由行 id 派生、浏览器半用 `configForms`）。旧版的 `settings.yaml` 已被 0.1.7 归档为 `settings.yaml.imported`。

## 安装

方式一（推荐）：在 profile 目录安装并登记为 bundle：

```bash
cd ~/.dsh/profiles/web
npm install github:rainforwind/dsh-plugin-pack#subdirectory=dsh-lan-proxy
```

方式二：克隆后手动复制：

```bash
git clone https://github.com/rainforwind/dsh-plugin-pack.git
cp -r dsh-plugin-pack/dsh-lan-proxy ~/.dsh/profiles/web/node_modules/
```

然后编辑 `~/.dsh/profiles/web/package.json`：

1. `dependencies` 中加入 `"dsh-lan-proxy": "file:./node_modules/dsh-lan-proxy"`（防被 `pnpm install` 清掉）；
2. `dsh.profile.bundles` 数组中加入 `"dsh-lan-proxy"`（放在其他条目之后即可）。

重启 `dsh web` 后插件挂载。**插件不预置任何默认 IP / 网段**：schema 默认 `enabled: false`；即使启用，`allow` 为空时也对外完全关闭（非回环监听 + 空白名单会拒绝启动并打印提示）。

## 配置

**dsh 0.1.7 起**，本插件的配置是组合里 `dsh-lan-proxy` 行的 `config`（行 id 即设置段名）。推荐直接用 Web GUI：

**Settings → Plugins → LAN Proxy** 标签页，或 Plugins 管理页里点开本插件条目。

手改配置文件则编辑 `~/.dsh/profiles/web/cordis.patch.yml`（热加载，保存即生效）：

```yaml
- id: dsh-lan-proxy
  name: 'dsh-lan-proxy'
  config:
    enabled: true
    host: "0.0.0.0"        # 监听地址；也可填本机某个网卡 IP，只对一个接口开放
    port: 3081             # 代理监听端口
    allow:                 # 来源白名单：按需填写，不预置任何默认网段；留空 = 不对外开放
      - 192.168.1.23       # 例：只允许某一台设备
      # - 10.0.0.0/8       # 例：某个网段（仅在可信网络这样做）
    targetHost: 127.0.0.1
    targetPort: 0
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `false` | 为 `true` 时才启动代理 |
| `host` | `0.0.0.0` | 代理监听地址；填具体网卡 IP 可只暴露该接口（该 IP 必须真实存在于本机，否则绑定失败） |
| `port` | `3081` | 代理监听端口；`0` 表示由系统分配 |
| `allow` | `[]` | 来源 IP / CIDR 白名单，**无默认值**；监听非回环地址且该列表为空时拒绝启动 |
| `targetHost` | `127.0.0.1` | 被代理的 Web 服务地址 |
| `targetPort` | `0` | 被代理的 Web 服务端口；`0` 表示跟随组合中 `webServer` 实际绑定的端口 |

> **升级提示**：dsh 0.1.7 取消了旧版 `~/.dsh/settings.yaml`，其内容会被自动改名归档为 `settings.yaml.imported`。旧版本写入的 `lan-proxy:` 段对应不上新的行 id，需要按上表改写到 `cordis.patch.yml`（或直接用面板重新填一次）。

## Settings 面板（无需手改配置文件）

插件附带浏览器半（`client/client.js`），在两处提供同一个配置页面：

- **Settings → Plugins → “LAN Proxy” 标签页**；
- **Plugins 管理页**中本插件的条目（列表里显示一句话摘要，打开即同一张表单）。

表单覆盖上表全部字段（`allow` 是每行一个 IP / CIDR 的多行文本框）：

- **本地暂存**：改动先作为草稿留在浏览器里，标题旁出现 *未保存* 标记；**保存** 落盘（写入带 revision 栅栏，若配置在别处被改过会**拒绝保存并提示冲突**，不覆盖旧值），**放弃** 丢弃草稿，**恢复默认值** 回到插件默认值（`enabled: false`、`allow: []`）。
- **保存即热生效**：dsh 重启该行 fiber，本插件按新配置重新绑定监听地址与白名单，无需重启 `dsh web`。
- **白名单校验**：逐行用与宿主一致的 IPv4 / IPv6 / CIDR 解析器校验，非法行立即标红并阻止保存；面板**不预置任何默认 IP / 网段**，名单留空仍等于对外关闭。
- **只读提示**：dsh 的设置只在本机回环页面落盘——通过代理 / 局域网 URL 打开的页面是进程内只读（表单会提示）。请在本机浏览器里修改。
- 中英文文案走 dsh 的 locale 服务（`zh` / `en`），跟随界面语言切换。

## 工作原理与安全说明

1. **Host/Origin 栅栏**：DSH 的 `/api` 要求 `Host` 是回环或受信权威，且附带的 `Origin` 必须等于 `Host`。代理把转发请求的 `Host` 重写为回环目标权威；`Origin` **仅当等于请求方原始权威（即同源流量）时**才一并重写，跨站 `Origin` 原样转发，由 DSH 自己的栅栏拒绝（测试覆盖该行为）。
2. **认证 cookie 按权威绑定**：cookie 的名字与签名都绑定服务端看到的权威。代理对所有请求统一重写为同一个回环权威，整个会话的 cookie 校验因此保持一致；访问控制的第一道闸仍然是来源 IP 白名单。
3. **认证覆盖范围**：DSH 对 `/api` 与首页有认证，但部分静态文件与个别插件自行注册的路由本身不带认证——它们也会经代理暴露给白名单内的设备。请把 `allow` 收窄到你控制的设备（Tailscale 场景下配合 tailnet ACL），不要对不可信网段开放。
4. **白名单之外的来源**：HTTP 返回 403，升级连接直接拒绝；白名单校验同时作用于普通请求和 WebSocket 升级。
5. 代理不会改写响应体、不会注入任何额外逻辑，DSH 侧看到的请求与"从本机直连"等价（额外附带 `X-Forwarded-For/Host/Proto` 便于审计）。

## 测试

```bash
cd dsh-lan-proxy
node test/run.mjs      # 代理核心：白名单、重写、转发、拒绝
node test/client.mjs   # 浏览器半：模块装载 + 面板状态机（草稿/保存/冲突）
```

覆盖：白名单匹配（IPv4/IPv6/CIDR/映射地址/回环）、非法配置拒绝启动、Host/Origin 重写与跨站不放行、HTTP 透传、SSE 流式转发、WebSocket 升级转发与拒绝、403 拦截；客户端模块在打桩的 `window.__ModuleLoader__` 下装配，覆盖行 id 表单绑定、两个插槽的注册、暂存、revision 栅栏保存、冲突提示、Discard/Reset 与白名单行校验。

（测试直接 import 插件源码，需要能解析 `@deepseek-ai/schemastery`；在 profile 内运行，或临时软链该包到本地 `node_modules/`。）

## 卸载

从 `dsh.profile.bundles` 移除 `dsh-lan-proxy` 条目、删除 `dependencies` 中的条目与 `node_modules/dsh-lan-proxy` 目录，重启 `dsh web`；`cordis.patch.yml` 中的 `dsh-lan-proxy` 行可一并删除。
