# ACP Adapter

网关使用 `@agentclientprotocol/sdk` 的稳定 ACP v1 接口作为客户端，通过 NDJSON stdin/stdout 与 Agent 通信。

内置 `opencode` 和 `deepseek-harness` 都直接使用官方 ACP 入口：

```bash
DEEPSEEK_API_KEY="..." npm start -- --engine deepseek-harness
opencode auth login
npm start -- --engine opencode
```

默认命令分别为 `opencode acp` 和 `dsh --profile acp`。如果对应可选依赖已安装，注册表会直接解析包内 CLI 入口，不依赖全局 `PATH`；也可以通过 `OPENCODE_COMMAND` 或 `DEEPSEEK_HARNESS_COMMAND` 覆盖。

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

原生进程因空闲超时关闭或网关重启后，逻辑 Session 仍保留。Adapter 新建 ACP Session 时会在第一条 prompt 中注入一次已持久化对话历史。

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
