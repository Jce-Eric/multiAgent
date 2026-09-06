# Codex app-server Adapter

`codeagent` 使用 OpenAI Codex CLI 的 `app-server` stdio JSON-RPC 接口。每个网关 Session 对应一个独立 app-server 进程和一个原生 Codex Thread，多轮消息复用同一个 Thread。

## 生命周期

```text
POST /v1/sessions
  -> initialize
  -> initialized
  -> thread/start (cwd + runtimeWorkspaceRoots)

POST /messages
  -> turn/start
  <- item/*, turn/* notifications
  <- server-to-client approval/question requests
  <- turn/completed

POST /stop
  -> turn/interrupt

DELETE /v1/sessions
  -> thread/delete
  -> terminate app-server process
```

Thread 使用 `ephemeral: true`，上下文在网关 Session 生命周期内保留，删除会话后不会留下 Codex 持久历史。`directory` 同时传给子进程工作目录、`thread/start.cwd` 和 `runtimeWorkspaceRoots`，用于项目隔离。

网关配置 SQLite 后会持久化逻辑 Session 和消息。Codex 进程因空闲回收或网关重启而重新创建 Thread 时，Adapter 会在第一条 Turn 中注入一次历史对话，恢复上下文。

## 事件映射

| Codex 消息 | 网关事件 |
| --- | --- |
| `item/agentMessage/delta` | `message.assistant.delta` + `agent.event` |
| `item/tool/requestUserInput` | `interaction.question` |
| `item/commandExecution/requestApproval` | `interaction.permission` |
| `item/fileChange/requestApproval` | `interaction.permission` |
| `item/permissions/requestApproval` | `interaction.permission` |
| 其他当前 Turn 通知/请求 | `agent.event` |
| `turn/completed` completed | `generation.completed` |
| `turn/completed` interrupted | `generation.stopped` |
| `turn/completed` failed / `error` | `generation.failed` + `error` |

`agent.event.data.type` 使用 `codex.<method>`，例如 `codex.item/started`；`agent.event.data.data` 保留原始 params。

## 反问与权限

`requestUserInput` 包含多道问题时，Adapter 会按顺序产生多个 `interaction.question`，最后将答案聚合为 Codex 要求的 question-id map。

命令和文件审批事件会携带可选项，例如 `accept`、`acceptForSession`、`decline`。客户端可以提交精确选项：

```json
{"optionId":"acceptForSession"}
```

兼容形式 `{"decision":"allow"}` 和 `{"decision":"deny"}` 会分别映射到当前请求支持的允许或拒绝决策。

## 配置

默认启动项目可选依赖中的 Codex CLI，也可以覆盖：

```bash
CODEAGENT_PROTOCOL=codex \
CODEAGENT_COMMAND="codex app-server --stdio" \
npm start -- --engine codeagent
```

Adapter 启用 app-server experimental API，以接收结构化 `requestUserInput` 请求。Codex CLI 协议可能随版本扩展；未建模的通知仍会通过 `agent.event` 原样保留。
