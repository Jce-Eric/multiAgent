# ACP Adapter

网关使用 `@agentclientprotocol/sdk` 的稳定 ACP v1 接口作为客户端，通过 NDJSON stdin/stdout 与 Agent 通信。

## 生命周期

每个网关 Session 对应一个独立的 ACP 子进程和原生 ACP Session：

```text
POST /v1/sessions
  -> initialize
  -> session/new

POST /messages
  -> session/prompt
  <- session/update ...
  <- PromptResponse

POST /stop
  -> session/cancel

DELETE /v1/sessions
  -> close connection and terminate process
```

同一网关 Session 的多条消息复用同一个 ACP Session，因此 Agent 可以保留自己的上下文。

## 事件映射

| ACP 消息 | 网关事件 |
| --- | --- |
| `agent_message_chunk` 文本 | `message.assistant.delta` + `agent.event` |
| 其他 `session/update` | `agent.event` |
| `elicitation/create` form | `interaction.question` |
| `session/request_permission` | `interaction.permission` |
| PromptResponse | `generation.completed` 或 `generation.stopped` |

`agent.event.data.type` 使用 `acp.<sessionUpdate>`，`agent.event.data.data` 保留 ACP 原始 update 对象。

## 反问

ACP form elicitation 的 schema 和 choices 会包含在 `interaction.question` 事件中。简单客户端可以继续提交：

```json
{"answer":"main"}
```

结构化表单可以提交：

```json
{"answers":{"branch":"main","runTests":true}}
```

## 权限

ACP 权限选项会包含在 `interaction.permission.data.options`。客户端可以精确选择：

```json
{"optionId":"allow-once"}
```

也可以使用兼容形式 `{"decision":"allow"}`，Adapter 会选择第一个 `allow_once` 或 `allow_always` 选项。
