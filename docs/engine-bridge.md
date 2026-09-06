# External Engine Bridge Protocol

每次生成会启动一个配置的子进程，并将会话的 `directory` 用作子进程工作目录。stdin/stdout 使用一行一个 JSON 对象的 JSONL 协议；stderr 只用于诊断。

JSONL bridge 协议版本为 `1`。它是本项目的兼容协议，不是业界标准；支持 ACP 时应优先使用 ACP Adapter。

网关首先写入：

```json
{"type":"run","sessionId":"...","runId":"...","directory":"/project","prompt":"...","messages":[]}
```

引擎可以输出以下事件：

```json
{"type":"delta","text":"partial text"}
{"type":"question","question":"Which branch?","choices":["main","dev"]}
{"type":"permission","operation":"write README.md","reason":"Update documentation"}
{"type":"completed"}
{"type":"error","message":"provider unavailable"}
```

收到 `question` 或 `permission` 后，引擎应暂停后续工作。客户端通过 HTTP 回答后，网关向同一子进程写入：

```json
{"type":"interaction.response","interaction":"question","answer":"main"}
{"type":"interaction.response","interaction":"permission","decision":"allow"}
```

引擎输出 `completed` 后本次生成结束。调用 stop API 时，网关先发送 `SIGTERM`，进程一秒内未退出则发送 `SIGKILL`。
