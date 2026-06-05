# kari

[English](README.md) | **中文**

<img width="1440" height="920" alt="image" src="https://github.com/user-attachments/assets/a9fd5080-2947-4850-ac6f-73d67d4b64e5" />

可自托管的 **团队 vibe coding 协作底座** —— 让团队在同一台共享 server 上跑
AI 编码 CLI(Claude Code、Codex、DeepSeek …),协同同一批项目。

团队指向同一台主机,在远程终端里跑各自的编码 CLI。**支持多开**(同时开很多会话)、
**多项目**(跨多个项目树);项目文件通过 [Syncthing](https://syncthing.net/)
双向同步,所有人**在同一批项目树上实时协同**;会话历史共享,可浏览并恢复过往的
CLI 运行。每个成员用一个共享密钥、走端到端加密连接接入 —— 桌面应用、Web 控制台、
命令行都连同一台 server。

这是开源的单租户内核:**无注册中心、无计费、无多租户密钥库、无云、无 LLM 代理、
无容器**。你自带 CLI 工具,在自己的机器上跑。

## 组成

| 组件 | 路径 | 说明 |
|------|------|------|
| **karid** | `cmd/karid` | server。说 gRPC FileService 协议(同步 / exec / PTY)+ HTTP,运行一个私有 Syncthing sidecar,并内嵌 serve Web 控制台。 |
| **桌面应用** | `client-desktop/` | Electron 客户端:打开本地项目目录即同步到 server;开远程终端;浏览会话历史。 |
| **Web 控制台** | `client-web/` → `web/` | 内嵌进 `karid` 根路径 `/` 的单页控制台。 |
| **kari** | `cmd/kari` | 打开远程 PTY 的命令行(`kari pty …`)。 |
| **kari-syncd** | `cmd/kari-syncd` | 桌面端 bundled 的环回控制守护进程。 |
| **kari-mcp-bridge** | `cmd/kari-mcp-bridge` | 通过签名环回 socket 把主机 shell 暴露给会话里的 AI CLI(Claude Code、Codex)—— MCP local-exec。 |

## 功能

- **远程跑编码 CLI** —— 在 server 上开真实终端,启动 `claude`、`codex`、`deepseek`…
  (POSIX 上是真 PTY,Windows 上是 ConPTY)。
- **多开、多项目** —— 同时开很多并发终端、跨多个项目树;每个项目是工作区里自己的
  同步 folder。
- **共享项目文件** —— Syncthing 把每个成员的项目树双向镜像(私有、关闭发现的
  sidecar,按需配对),让团队在同一批代码上协同。
- **共享会话历史** —— 浏览并恢复过往的 Claude / Codex 会话(从主机的
  `~/.claude`、`~/.codex` 提取)。
- **MCP local-exec 桥** —— 让 AI CLI 经受审计的环回桥执行主机命令。
- **内嵌 Web 控制台** —— 无需单独部署 web 服务。
- **跨平台** server(macOS、Linux、Windows)。

## 环境要求

- 构建 server / Go 二进制:**Go 1.25+**。
- 构建/运行桌面应用:**Node 18+**。
- server 主机上需有 **Syncthing v1.30**(桌面应用也会 bundle 它)。

  > ⚠️ **用 Syncthing v1.30,不要用 v2.x。** sidecar 驱动 Syncthing 的 REST API;
  > v2 的 API 不兼容,健康检查起不来。在 v2 支持落地前请锁定 v1.30。

Syncthing 是 **强制** 的 —— sidecar 起不来 server 就中止启动,且 gRPC 流以
control-only 运行(Syncthing 是唯一的文件搬运者)。文件同步就是这个产品的核心;
不存在"无同步也能跑"的降级模式。

## 快速开始(server)

整个仓库是一个根 Go module。在仓库根目录构建并运行:

```sh
# Syncthing v1.30 需在 PATH 中(或用 --syncthing-binary /abs/path 指定)
go build -o karid ./cmd/karid
./karid --listen 0.0.0.0:8443 --sync-dir ./workspaces
```

如果你不设密钥,`karid` 会生成一个强随机串、打印一次、并保存到
`<sync-dir>/.kari-secret`(跨重启稳定):

```
no KARI_SECRET set — generated one and saved it to ./workspaces/.kari-secret:
    a6G7QTL1dpSeYIatNYJcR1B6N7KOzGpL
share it with your team; they enter it as the shared secret.
```

浏览器打开 `https://<host>:8443/` 即是控制台。让客户端指向同一台主机,填这个密钥。

## 共享密钥(你团队的 token)

kari 是 **可信成员间的团队分享**,不是多租户隔离。每台 server 只有一个密钥 ——
它就是访问 token:

- **设置**:用 `KARI_SECRET` / `--secret`,或让 `karid` 自动生成(见上)。
- **客户端就填它**(桌面端的 "Shared secret" 输入框、`kari --license`)。传输密钥是
  `SHA-256(secret)`,两端用同样方式派生。
- **生成强密钥**:任意随机串即可,例如 `openssl rand -base64 24`,或干脆让
  `karid` 生成并落盘。
- **轮换 / 吊销**:改密钥即可 —— 每个客户端都得重新填新的,所以轮换密钥相当于把
  所有人踢下线(本版本没有 per-client token,那会往多租户回退,见《安全》)。

把密钥当 root 口令对待:谁拿到它谁就能在主机上拿到 shell。

## 桌面应用

```sh
cd client-desktop
npm install
# 把运行时二进制放到 app 期望的位置:
#   bundled-runtime/<platform>/{kari-syncd, syncthing, kari}
#   (从本仓库构建 kari-syncd + kari;放入 Syncthing v1.30)
npm run dev        # 或:  npm run build && npm run package
```

首次启动是激活页 —— 填 **server 地址**(`host:8443`)和 **共享密钥**。打开一个
项目目录即同步到 server;开一个终端就在同一棵树里得到远程 shell。

桌面应用用自己的 app-data 目录(`kari-oss`)和自己的守护进程端口(`46331`),
因此不会和同机上别的 kari 安装冲突。

## 配置(server)

每个 flag 都有对应的环境变量;flag 优先于环境变量。

| Flag | 环境变量 | 默认 | 含义 |
|------|----------|------|------|
| `--listen` | `KARI_LISTEN_ADDR` | `0.0.0.0:8443` | 监听地址 |
| `--sync-dir` | `KARI_SYNC_DIR` | `./workspaces` | 存放同步工作区树的根目录 |
| `--secret` | `KARI_SECRET` | 自动生成 | 共享密钥;客户端拿它当 token |
| `--shell` | `KARI_SHELL` | `/bin/bash` | exec / PTY 用的 shell |
| `--syncthing-binary` | `KARI_SYNCTHING_BINARY` | 自动(PATH) | Syncthing v1.30 二进制的绝对路径 |
| `--syncthing-port` | `KARI_SYNCTHING_PORT` | `22000` | sidecar 绑定(`0.0.0.0`)且客户端连接的 BEP 数据端口 |
| `--syncthing-addr` | `KARI_SYNCTHING_ADDR` | 由请求 host + 端口推导 | 通告给客户端的 Syncthing 地址(覆盖推导值) |

## 工作原理

```
桌面端 / 命令行 ──┬─ gRPC FileService(cmux 复用,AES-GCM 信封)──► karid
                  │     ├─ Sync → 仅控制通道(bootstrap、会话列表、MCP local-exec、
                  │     │          PTY 计数)—— 文件走 Syncthing
                  │     ├─ Exec → remoteexec.Runner(流式输出)
                  │     └─ Pty  → remoteexec.PtyRunner → 主机 shell(PTY / ConPTY)
                  │
                  ├─ HTTP  /healthz、/v1/sessions、/v1/syncthing/pair、/(控制台)
                  │
                  └─ Syncthing(tcp :22000)◄── 私有 sidecar,按项目配对

会话里的 AI CLI ──► kari-mcp-bridge ──► 签名环回 socket ──► karid local-exec
```

- **一个密钥,一把钥匙。** gRPC 握手携带由 `SHA-256(secret)` 加密的 AES-GCM 信封;
  server 的 `singleKeyResolver` 对任意 `workspace_id` 都返回这把唯一的钥匙。
- **工作区与项目。** 工作区是子树 `<sync-dir>/<workspace_id>/<workspace_name>`;
  每个配对的项目是它**内部**的一个 Syncthing folder,所以在工作区根的远程终端能把
  每个同步项目看作子目录。
- **Syncthing 是文件面。** 作为私有 sidecar 启动(关闭 LAN/全局发现、relay、NAT),
  绑定在固定的可对外访问端口上。gRPC `Sync` 流两端都是 control-only —— 永不搬文件。
- **配对。** `POST /v1/syncthing/pair`(Bearer = 密钥)注册客户端设备、创建项目
  folder,并返回 server 的设备 id + 地址,客户端据此配置自己这侧。

## 安全说明

- 把 `KARI_SECRET` 当 root 口令:谁有它谁就能在主机上拿 shell。用长随机值,并在 TLS 后面 serve。
- server 在**主机上直接**跑 shell —— 本开源版没有沙箱。请部署在你愿意把 shell 交给团队的机器上。
- Syncthing sidecar 的 home 是 `0700` 且拒绝软链 home;配对路径会被校验(解析软链后)确保落在 `--sync-dir` 内。
- Syncthing BEP 端口(`--syncthing-port`,默认 `22000`)绑在所有网卡上以便远程客户端可达;
  发现/relay/NAT 都关,因此只有显式配对过的设备才能连。**配对需要密钥**,但一旦某设备
  配对完成,它的 Syncthing 设备 ID 就成了一个长期凭据 —— 之后无需再出示密钥即可继续同步。
  要吊销某客户端,从 sidecar 的 `config.xml` 里删掉它的设备。轮换 `KARI_SECRET` 会阻止
  新配对和所有 gRPC 访问,但不会自动剔除已配对的设备。(per-client 可吊销 token —— 即
  鉴权与数据密钥解耦 —— 是日后可能的扩展;在这个纯团队分享版本里刻意不做。)

## 仓库结构

```
kari/
├── cmd/karid              server
├── cmd/kari               远程 PTY 命令行
├── cmd/kari-syncd         桌面端 bundled 的控制守护进程
├── cmd/kari-mcp-bridge    MCP local-exec 桥
├── internal/              共享内核(transport、filesync、syncthing …)
├── web/                   内嵌 Web 控制台(go:embed dist)
├── client-web/            控制台 SPA 源码
├── client-desktop/        Electron 桌面客户端
└── go.mod                 module github.com/binsonzhang95-maker/kari
```

## 许可

kari 采用 **GNU AGPL-3.0** —— 见 [LICENSE](LICENSE),覆盖整个仓库:server、
Web 控制台(`client-web/`)和桌面应用(`client-desktop/`)。你可以自用、修改、
自托管(含商用),但只要把它对外做成网络服务,就必须以同一许可公开你的全部修改源码。
第三方组件及其许可见 [NOTICE](NOTICE)。
