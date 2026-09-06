# Multi-Agent Gateway

一个面向 coding agent 的统一 HTTP/SSE 网关。网关维护会话和状态机，引擎适配器只负责生成内容以及发起反问、权限请求，因此可以在不改变客户端 API 的情况下替换 Agent。

## 启动

要求 Node.js 20.9 或更高版本。`npm install` 会安装 Codex CLI 和 DeepSeek Harness 作为可选运行时依赖。

```bash
npm install
npm start -- --engine codeagent --port 3000
```

内置引擎名称：`codeagent`、`opencode`、`deepseek-harness`。启动参数优先级为 `--engine` > `AGENT_ENGINE` > `codeagent`。

| 引擎 | 默认实现 | 前置条件 |
| --- | --- | --- |
| `codeagent` | OpenAI Codex `app-server` JSON-RPC | 完成 Codex 登录或配置 API Key |
| `deepseek-harness` | DeepSeek Harness 官方 `dsh --profile acp` | 设置 `DEEPSEEK_API_KEY` |
| `opencode` | 内置参考实现，可配置为 JSONL/ACP 外部进程 | 取决于配置的 Agent |

两个原生引擎不会在启动失败时静默切换到参考实现。创建会话时如果二进制、认证或配置不可用，API 会返回 `ENGINE_SESSION_ERROR` 及诊断信息。

启动 DeepSeek Harness：

```bash
DEEPSEEK_API_KEY="..." npm start -- --engine deepseek-harness
```

可以覆盖原生启动命令：

```bash
CODEAGENT_COMMAND="/opt/codex app-server --stdio"
DEEPSEEK_HARNESS_COMMAND="/opt/dsh --profile acp"
```

Codex 映射说明见 [docs/codex-app-server.md](docs/codex-app-server.md)，DeepSeek Harness 使用的 ACP 映射见 [docs/acp.md](docs/acp.md)。

`opencode` 在只设置 `OPENCODE_COMMAND` 时使用外部 JSONL 子进程适配器：

```bash
OPENCODE_COMMAND="my-opencode-bridge" npm start -- --engine opencode
```

也可以对任意内置引擎显式设置 `*_PROTOCOL=reference|jsonl|acp|codex`。外部 JSONL 桥接协议见 [docs/engine-bridge.md](docs/engine-bridge.md)。

### ACP Agent

支持 Agent Client Protocol（ACP）v1 的 Agent 不需要为网关事件格式编写专用适配器。可以直接设置内置引擎的协议：

```bash
OPENCODE_PROTOCOL=acp \
OPENCODE_COMMAND="your-acp-agent-command" \
npm start -- --engine opencode
```

也可以使用配置文件注册任意新 Agent，无需修改 TypeScript 注册表：

```bash
AGENT_ENGINE_CONFIG=./agents.json npm start -- --engine my-agent
```

配置格式见 [agents.example.json](agents.example.json)，ACP 映射说明见 [docs/acp.md](docs/acp.md)。

## API

```text
GET    /health
GET    /v1/engines
GET    /v1/events
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:sessionId
DELETE /v1/sessions/:sessionId
POST   /v1/sessions/:sessionId/messages
POST   /v1/sessions/:sessionId/interactions/:requestId/respond
POST   /v1/sessions/:sessionId/stop
```

创建项目隔离会话：

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"directory":"/absolute/project/path"}'
```

订阅全局事件流：

```bash
curl -N http://127.0.0.1:3000/v1/events
```

发送消息后接口立即返回 `runId`，内容增量、反问、权限请求、完成、终止和失败均通过 SSE 推送。客户端也可以再次请求会话获取完整消息历史。Agent 未被统一建模的原生事件通过 `agent.event` 保留，避免适配时丢失工具调用、计划或用量信息。

反问响应 body 为 `{"answer":"..."}`；权限响应 body 为 `{"decision":"allow"}` 或 `{"decision":"deny"}`。

需要本地演示或测试参考实现时，可以显式设置 `CODEAGENT_PROTOCOL=reference`。参考引擎提供验收标记：`[[ask:问题]]`、`[[permission:操作]]`、`[[slow:毫秒]]`、`[[error:信息]]` 和 `[[pwd]]`。

## 验证

```bash
npm test
npm run typecheck
npm run build
```
