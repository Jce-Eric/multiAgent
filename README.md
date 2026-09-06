# Multi-Agent Gateway

面向 coding agent 的统一 HTTP/SSE 网关。客户端只依赖 Session、Message、Run、Interaction 和 Event API；`--engine` 选择默认 Agent，每个 Session 也可以选择其他已配置 Agent。

## 支持的引擎

| 引擎 | 默认 Adapter | 默认命令 | 认证 |
| --- | --- | --- | --- |
| `codeagent` | Codex app-server JSON-RPC | 项目内 `codex app-server --stdio` | Codex 登录或 API Key |
| `opencode` | ACP | 项目内 `opencode acp` | OpenCode provider 配置 |
| `deepseek-harness` | ACP | 项目内 `dsh --profile acp` | `DEEPSEEK_API_KEY` |

三种 CLI 都是可选依赖，安装后优先使用项目内二进制，不依赖全局 `PATH`。原生引擎启动失败时不会静默降级到参考实现。

## 启动

要求 Node.js 22.5 或更高版本。

```bash
npm install
npm start -- --engine codeagent --port 3000
```

选择顺序为 `--engine` > `AGENT_ENGINE` > `codeagent`：

```bash
npm start -- --engine opencode
DEEPSEEK_API_KEY="..." npm start -- --engine deepseek-harness
```

健康检查和协议元数据：

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
curl http://127.0.0.1:3000/v1/engines
```

## API

```text
GET    /health
GET    /ready
GET    /metrics
GET    /openapi.yaml
GET    /asyncapi.yaml
GET    /v1/engines
GET    /v1/events
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:sessionId
DELETE /v1/sessions/:sessionId
POST   /v1/sessions/:sessionId/messages
POST   /v1/sessions/:sessionId/interactions/:requestId/respond
POST   /v1/sessions/:sessionId/stop
GET    /v1/sessions/:sessionId/runs
GET    /v1/runs/:runId
```

完整契约见 [openapi.yaml](openapi.yaml)。架构与扩展方式见 [docs/architecture.md](docs/architecture.md)。
SSE 契约见 [asyncapi.yaml](asyncapi.yaml)，十轮架构审视和取舍见 [docs/architecture-exploration.md](docs/architecture-exploration.md)。

创建项目会话：

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"directory":"/absolute/project/path"}'
```

可选地为单个 Session 选择引擎；不传时继续使用 `--engine` 默认值：

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"directory":"/absolute/project/path","engine":"opencode"}'
```

发送消息后立即返回 `runId`，可通过 `/v1/runs/:runId` 查询规范化运行状态：

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/SESSION_ID/messages \
  -H 'content-type: application/json' \
  -d '{"content":"检查项目并运行测试"}'
```

订阅全局或单会话 SSE：

```bash
curl -N http://127.0.0.1:3000/v1/events
curl -N 'http://127.0.0.1:3000/v1/events?sessionId=SESSION_ID'
```

支持 `Last-Event-ID` header 和 `lastEventId` query。内存模式回放当前进程保留的事件；SQLite 模式会持久化事件和递增 ID，因此重启后仍可继续回放。事件包含消息增量、Run 状态、反问、权限、原生 Agent 事件、完成、失败、终止和 Session 状态切换。

反问响应：

```json
{"answer":"main"}
```

权限响应可以使用通用决策或 Agent 原生选项：

```json
{"decision":"allow"}
{"optionId":"acceptForSession"}
```

错误格式固定包含错误码、描述和请求 ID：

```json
{
  "error": {
    "code": "SESSION_BUSY",
    "message": "Session '...' is already busy",
    "requestId": "..."
  }
}
```

## 持久化与恢复

默认使用内存仓储。配置 SQLite 后，Session、消息、Run 和 SSE 事件在服务重启后保留：

```bash
GATEWAY_DATABASE_PATH=./data/gateway.db npm start -- --engine opencode
```

SQLite 使用 WAL。重启时遗留的 `busy` Session 会恢复为 `idle`，未完成 Run 会恢复为 `failed`。原生 Agent 进程被空闲回收或服务重启后，下一次生成会创建新原生 Session，并用已保存消息做一次上下文回放。

## 安全和资源策略

```bash
GATEWAY_API_KEY="strong-secret" \
AGENT_ALLOWED_ROOTS="/srv/project-a:/srv/project-b" \
PERMISSION_POLICY=client \
npm start -- --engine codeagent
```

配置 API Key 后，`/v1` 和 `/metrics` 接受 `Authorization: Bearer ...` 或 `X-API-Key`。`/health`、`/ready`、`/openapi.yaml` 和 `/asyncapi.yaml` 保持公开，便于探针和契约发现。

`AGENT_ALLOWED_ROOTS` 使用平台路径分隔符连接多个根目录。网关对请求目录做 `realpath` 校验，可阻止父目录和符号链接逃逸。它提供项目边界校验，但不是操作系统沙箱；生产部署建议配合容器隔离。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_SESSIONS` | `100` | 网关最大逻辑 Session 数 |
| `MAX_CONCURRENT_RUNS` | `10` | 全局同时生成数 |
| `MAX_MESSAGES_PER_SESSION` | `200` | 单 Session 最大消息数 |
| `GENERATION_TIMEOUT_MS` | `600000` | 单次生成超时，`0` 禁用 |
| `IDLE_SESSION_TIMEOUT_MS` | `300000` | 原生进程空闲回收时间，`0` 禁用 |
| `EVENT_HISTORY_LIMIT` | `1000` | SSE 回放事件数 |
| `PERMISSION_POLICY` | `client` | `client`、`allow` 或 `deny` |
| `LOG_LEVEL` | `info` | `info` 输出 JSON 请求日志，`silent` 关闭 |

示例配置见 [.env.example](.env.example)。

## 接入新 Agent

支持 ACP 的 Agent 只需配置，无需修改网关代码：

```json
{
  "engines": {
    "my-agent": {
      "protocol": "acp",
      "command": "my-agent --acp",
      "displayName": "My Agent"
    }
  }
}
```

```bash
AGENT_ENGINE_CONFIG=./agents.json npm start -- --engine my-agent
```

不支持 ACP 的 Agent 可以使用 `jsonl` bridge，或实现原生 `AgentEngine` Adapter。ACP 映射见 [docs/acp.md](docs/acp.md)，JSONL 协议见 [docs/engine-bridge.md](docs/engine-bridge.md)，Codex 映射见 [docs/codex-app-server.md](docs/codex-app-server.md)。

内置引擎也可以覆盖协议和命令：

```bash
OPENCODE_PROTOCOL=jsonl OPENCODE_COMMAND="my-opencode-bridge" npm start -- --engine opencode
CODEAGENT_PROTOCOL=reference npm start -- --engine codeagent
```

## Docker

```bash
GATEWAY_API_KEY="..." docker compose up --build
```

Compose 默认把当前仓库挂载为 `/workspace`，SQLite 数据写入命名卷。切换引擎可设置 `AGENT_ENGINE`。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```

默认测试使用协议 fixture，不需要 Agent 凭据，也不会调用模型。显式启用真实 CLI 和模型测试会使用现有凭据并可能产生费用：

```bash
RUN_REAL_AGENT_TESTS=1 npm run test:integration
```

调用示例见 [examples/typescript-client.ts](examples/typescript-client.ts) 和 [examples/python-client.py](examples/python-client.py)。
