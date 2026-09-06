# Architecture

## 分层

```text
HTTP/SSE Client
      |
      v
Express API + auth + request IDs + metrics
      |
      v
GatewayService compatibility facade
      |
      +-- EngineCatalog (default engine + per-session routing)
      +-- WorkspaceResolver (local workspace boundary)
      +-- SessionRepository (memory / SQLite)
      +-- RunRepository (memory / SQLite)
      +-- InteractionRepository (memory / SQLite)
      +-- EventBus + EventRepository (memory / SQLite)
      +-- TransactionCoordinator (no-op / shared SQLite)
      |
      v
AgentEngine contract
      |
      +-- Codex app-server JSON-RPC
      +-- ACP: OpenCode / DeepSeek Harness / other ACP Agents
      +-- JSONL bridge for legacy Agents
      +-- reference engine for deterministic tests
```

`GatewayService` 是协议无关的兼容门面，统一维护 Session、Run、Interaction、FIFO 调度、取消、超时、资源限制和权限策略。Engine Catalog 允许一个网关同时承载多个 Agent，`--engine` 只决定默认引擎。Adapter 不接触 HTTP，只把原生 Agent 消息映射成 `emitDelta`、`askQuestion`、`requestPermission` 和 `emitEvent`。

Run 是规范化执行实体，状态为 `queued | running | input_required | canceling | completed | failed | canceled`。达到并发上限后 Run 留在 FIFO 队列中，获得执行槽位后切换为 `running`；排队阶段也支持取消。现有 Session `idle | busy` 状态继续保留，作为 Run 状态的兼容投影。

## 会话和恢复

每个逻辑 Session 记录 Agent、Workspace、项目真实路径、状态和消息。配置 `GATEWAY_DATABASE_PATH` 后使用 SQLite WAL 持久化 Session、Run、Interaction 和事件；进程重启时遗留的 `busy` 会话恢复为 `idle`，未完成 Run 恢复为带 `GATEWAY_RESTARTED` 错误的 `failed`，未回答 Interaction 标记为 `canceled` 并保留审计信息。

SSE envelope 固定包含 `id`、`specVersion`、`source`、`type`、`timestamp` 和 `data`。SQLite 模式下事件 ID 跨重启单调递增，`Last-Event-ID` 可以继续回放保留窗口内的事件。事件契约见 [../asyncapi.yaml](../asyncapi.yaml)。

标准 `createApp()` SQLite 配置为 Session、Run、Interaction 和 Event Repository 创建一个共享 `SqliteDatabase`。`GatewayService` 通过同步嵌套事务提交领域状态和 `gateway_events` 记录，并在提交完成后才把事件交给进程内 SSE 订阅者。若任何写入失败，数据库事务和对应的内存领域对象都会恢复到转换前状态，回滚事件不会被投递。

`gateway_events` 同时承担持久事件日志和本地事务 outbox 的职责。当前消费者通知发生在同一网关进程的提交后阶段，适合单实例部署；未来的多实例 fanout 需要独立 relay 读取事件日志，并配合实例租约或外部消息系统。手动注入独立 Repository 时，为兼容现有扩展不会自动宣称跨仓储事务保证。

Codex、OpenCode 和 DeepSeek Harness 的原生进程仍是临时运行时。空闲超时或网关重启后，下一条消息会重新创建原生 Session，并在第一个 prompt 前注入一次已持久化对话，恢复 Agent 上下文。

## 接入新 Agent

优先级如下：

1. Agent 支持 ACP：在 `AGENT_ENGINE_CONFIG` 中声明 `protocol: "acp"` 和启动命令，无需编写 TypeScript Adapter。
2. Agent 有稳定原生协议：实现 `AgentEngine`，保留其会话、权限和取消语义。
3. Agent 只有自定义 CLI 输出：写一个 JSONL bridge，把原生事件转换为网关 bridge 协议。

应用内还可以调用 `registerEngineProtocol()` 注册新的协议工厂。协议实现只存在于南向 Driver 层，不改变 Session、Message、Run、Interaction 和 Event API。

ACP 是当前最接近跨 Agent 通用标准的协议，但不是所有 Agent 都支持。Codex app-server 使用自己的 JSON-RPC，因此仍需要专用 Adapter。未统一建模的原生事件通过 `agent.event` 完整透传，避免丢失工具调用、计划和 usage 信息。

## 隔离与安全

- `directory` 在创建 Session 时转换为真实路径。
- `AGENT_ALLOWED_ROOTS` 使用真实路径包含判断，阻止 `..` 和符号链接逃逸。
- `GATEWAY_API_KEY` 保护 `/v1` 和 `/metrics`。
- `PERMISSION_POLICY=client|allow|deny` 决定权限由客户端审批还是服务端自动处理。
- 每个原生 Session 使用独立子进程和工作目录；这不是操作系统级沙箱，生产环境仍应使用容器或更强隔离。
