# Multi-Agent Gateway

一个面向 coding agent 的统一 HTTP/SSE 网关。网关维护会话和状态机，引擎适配器只负责生成内容以及发起反问、权限请求，因此可以在不改变客户端 API 的情况下替换 Agent。

## 启动

```bash
npm install
npm start -- --engine codeagent --port 3000
```

支持的引擎名称：`codeagent`、`opencode`、`deepseek-harness`。启动参数优先级为 `--engine` > `AGENT_ENGINE` > `codeagent`。

未设置桥接命令时，服务使用可直接运行的内置参考引擎。设置下面任一环境变量后，对应引擎会切换为外部 JSONL 子进程适配器：

```bash
CODEAGENT_COMMAND="my-codeagent-bridge"
OPENCODE_COMMAND="my-opencode-bridge"
DEEPSEEK_HARNESS_COMMAND="my-deepseek-bridge"
```

外部桥接协议见 [docs/engine-bridge.md](docs/engine-bridge.md)。

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

发送消息后接口立即返回 `runId`，内容增量、反问、权限请求、完成、终止和失败均通过 SSE 推送。客户端也可以再次请求会话获取完整消息历史。

反问响应 body 为 `{"answer":"..."}`；权限响应 body 为 `{"decision":"allow"}` 或 `{"decision":"deny"}`。

内置参考引擎提供验收标记：`[[ask:问题]]`、`[[permission:操作]]`、`[[slow:毫秒]]`、`[[error:信息]]` 和 `[[pwd]]`。

## 验证

```bash
npm test
npm run typecheck
npm run build
```
