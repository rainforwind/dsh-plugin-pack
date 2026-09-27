# dsh-lan-proxy

把只监听 `127.0.0.1` 的 DSH Web GUI 按 IP 白名单开放给局域网 / Tailscale 设备的反向代理插件。

DSH 出于安全考虑只在回环地址提供 Web 服务，`dsh web --host 0.0.0.0` 被刻意拒绝。本插件不改动原有的监听与任何其他插件的组合行，而是**另开一道门**：

```
局域网/Tailscale 设备 ──▶ dsh-lan-proxy（独立 host:port + 来源 IP 白名单）
                              │  Host/Origin 重写为回环权威
                              ▼
                        127.0.0.1:<web 端口>（原有 Web 服务，行为不变）
```

- **来源白名单**：只放行 `allow` 里的 IP / CIDR（如 `100.64.0.5`、`100.64.0.0/10`）；回环来源始终放行（本机本来就能直连）。
- **协议全支持**：普通 HTTP、SSE（`/api` 的事件流）、WebSocket 升级（`/api/remote.mux`）全部转发。
- **零侵入**：只读取消费 `webServer` / `connection` / `settings` 三个服务，不注册任何路由、不改写任何别人的组合行，卸载即消失。
- **热配置**：配置存放在 `lan-proxy` settings 命名空间（`$DSH_HOME/settings.yaml`），修改后立即生效，无需重启。

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

重启 `dsh web` 后插件挂载（默认 `enabled: false`，不产生任何行为）。

## 配置

编辑 `~/.dsh/settings.yaml`，加入 `lan-proxy` 段（该文件热加载，保存即生效）：

```yaml
lan-proxy:
  enabled: true
  host: "0.0.0.0"          # 监听地址；也可填本机某个网卡 IP（如 Tailscale 的 100.x.x.x）只对一个接口开放
  port: 3081               # 代理监听端口
  allow:                   # 来源 IP 白名单：精确 IP 或 CIDR
    - 100.64.0.0/10        # Tailscale 全段（100.64.0.0/10）；建议收窄到具体设备 IP
    # - 100.101.102.103    # 例如只允许某一台设备
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `false` | 为 `true` 时才启动代理 |
| `host` | `0.0.0.0` | 代理监听地址；填具体网卡 IP 可只暴露该接口 |
| `port` | `3081` | 代理监听端口；`0` 表示由系统分配 |
| `allow` | `[]` | 来源 IP / CIDR 白名单；**监听非回环地址且该列表为空时拒绝启动** |
| `targetHost` | `127.0.0.1` | 被代理的 Web 服务地址 |
| `targetPort` | `0` | 被代理的 Web 服务端口；`0` 表示跟随组合中 `webServer` 实际绑定的端口 |

启动成功后日志会打印（前缀 `[lan-proxy]`）：

```
[lan-proxy] listening on 0.0.0.0:3081 → 127.0.0.1:3080
[lan-proxy] allowed sources: 100.64.0.0/10
[lan-proxy] LAN: http://100.101.102.103:3081/?token=<进程令牌>
```

把打印出来的 `LAN:` URL 在远程设备上打开即可完成认证（与本机 URL 使用同一套 `?token=` 换 cookie 机制）。

## 工作原理与安全说明

1. **Host/Origin 栅栏**：DSH 的 `/api` 要求 `Host` 是回环或受信权威，且附带的 `Origin` 必须等于 `Host`。代理把转发请求的 `Host` 重写为回环目标权威；`Origin` **仅当等于请求方原始权威（即同源流量）时**才一并重写，跨站 `Origin` 原样转发，由 DSH 自己的栅栏拒绝（测试覆盖该行为）。
2. **认证 cookie 按权威绑定**：cookie 的名字与签名都绑定服务端看到的权威。代理对所有请求统一重写为同一个回环权威，整个会话的 cookie 校验因此保持一致；访问控制的第一道闸仍然是来源 IP 白名单。
3. **认证覆盖范围**：DSH 对 `/api` 与首页有认证，但部分静态文件与个别插件自行注册的路由本身不带认证——它们也会经代理暴露给白名单内的设备。请把 `allow` 收窄到你控制的设备（Tailscale 场景下配合 tailnet ACL），不要对不可信网段开放。
4. **白名单之外的来源**：HTTP 返回 403，升级连接直接拒绝；白名单校验同时作用于普通请求和 WebSocket 升级。
5. 代理不会改写响应体、不会注入任何额外逻辑，DSH 侧看到的请求与"从本机直连"等价（额外附带 `X-Forwarded-For/Host/Proto` 便于审计）。

## 测试

```bash
cd dsh-lan-proxy
node test/run.mjs
```

覆盖：白名单匹配（IPv4/IPv6/CIDR/映射地址/回环）、非法配置拒绝启动、Host/Origin 重写与跨站不放行、HTTP 透传、SSE 流式转发、WebSocket 升级转发与拒绝、403 拦截。

（测试直接 import 插件源码，需要能解析 `@deepseek-ai/schemastery`；在 profile 内运行，或临时软链该包到本地 `node_modules/`。）

## 卸载

从 `dsh.profile.bundles` 移除 `dsh-lan-proxy` 条目、删除 `dependencies` 中的条目与 `node_modules/dsh-lan-proxy` 目录，重启 `dsh web`；`settings.yaml` 中的 `lan-proxy` 段可一并删除。
