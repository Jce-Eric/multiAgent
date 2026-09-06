import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { GatewayEvent, GatewayEventType, Session } from "../src/types.js";

interface TestServer {
  baseUrl: string;
  server: Server;
}

async function startServer(engine = "codeagent"): Promise<TestServer> {
  const { app } = createApp({ engine });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

async function requestJson(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

class SseClient {
  readonly events: GatewayEvent[] = [];
  private readonly controller = new AbortController();
  private waiters: Array<{
    predicate: (event: GatewayEvent) => boolean;
    resolve: (event: GatewayEvent) => void;
  }> = [];
  private reading?: Promise<void>;

  async connect(url: string): Promise<void> {
    const response = await fetch(url, { signal: this.controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert(response.body);
    this.reading = this.read(response.body.getReader());
  }

  waitFor(
    type: GatewayEventType,
    predicate: (event: GatewayEvent) => boolean = () => true,
    timeout = 3_000,
  ): Promise<GatewayEvent> {
    const existing = this.events.find((event) => event.type === type && predicate(event));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
      this.waiters.push({
        predicate: (event) => event.type === type && predicate(event),
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.reading?.catch((error) => {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    });
  }

  private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data) this.push(JSON.parse(data) as GatewayEvent);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private push(event: GatewayEvent): void {
    this.events.push(event);
    const matching = this.waiters.filter((waiter) => waiter.predicate(event));
    this.waiters = this.waiters.filter((waiter) => !waiter.predicate(event));
    for (const waiter of matching) waiter.resolve(event);
  }
}

test("session lifecycle, directory isolation, messages, status, stop, and errors", async () => {
  const testServer = await startServer();
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-project-"));
  const sse = new SseClient();
  try {
    await sse.connect(`${testServer.baseUrl}/v1/events`);
    const created = await requestJson(testServer.baseUrl, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ directory: project }),
    });
    assert.equal(created.status, 201);
    const session = created.body.session as Session;
    assert.equal(session.directory, project);
    assert.equal(session.status, "idle");

    const fetched = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.session.id, session.id);

    const sent = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "[[pwd]]" }),
    });
    assert.equal(sent.status, 202);
    const runId = sent.body.runId as string;
    await sse.waitFor("generation.completed", (event) => event.runId === runId);
    const completed = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}`);
    assert.equal(completed.body.session.status, "idle");
    assert.match(completed.body.session.messages.at(-1).content, new RegExp(project));

    const slow = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "[[slow:5000]] long task" }),
    });
    assert.equal(slow.status, 202);
    await sse.waitFor("generation.started", (event) => event.runId === slow.body.runId);
    const busy = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}`);
    assert.equal(busy.body.session.status, "busy");

    const duplicate = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "second" }),
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(Object.keys(duplicate.body.error).sort(), ["code", "message", "requestId"]);
    assert.equal(duplicate.body.error.code, "SESSION_BUSY");

    const stopped = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}/stop`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(stopped.status, 202);
    await sse.waitFor("generation.stopped", (event) => event.runId === slow.body.runId);
    await sse.waitFor(
      "session.status.changed",
      (event) => event.runId === slow.body.runId && (event.data as any).status === "idle",
    );

    const deleted = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 204);
    const missing = await requestJson(testServer.baseUrl, `/v1/sessions/${session.id}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "SESSION_NOT_FOUND");

    const badDirectory = await requestJson(testServer.baseUrl, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ directory: path.join(project, "missing") }),
    });
    assert.equal(badDirectory.status, 400);
    assert.equal(badDirectory.body.error.code, "DIRECTORY_NOT_FOUND");
  } finally {
    await sse.close();
    await closeServer(testServer.server);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("question, permission, failure, and every SSE domain event type", async () => {
  const testServer = await startServer();
  const sse = new SseClient();
  try {
    await sse.connect(`${testServer.baseUrl}/v1/events`);
    const created = await requestJson(testServer.baseUrl, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const sessionId = created.body.session.id as string;
    const sent = await requestJson(testServer.baseUrl, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: "[[ask:Which branch?]] [[permission:write README.md]] continue",
      }),
    });
    const runId = sent.body.runId as string;

    const question = await sse.waitFor("interaction.question", (event) => event.runId === runId);
    const questionResponse = await requestJson(
      testServer.baseUrl,
      `/v1/sessions/${sessionId}/interactions/${(question.data as any).requestId}/respond`,
      { method: "POST", body: JSON.stringify({ answer: "main" }) },
    );
    assert.equal(questionResponse.status, 202);

    const permission = await sse.waitFor("interaction.permission", (event) => event.runId === runId);
    const permissionResponse = await requestJson(
      testServer.baseUrl,
      `/v1/sessions/${sessionId}/interactions/${(permission.data as any).requestId}/respond`,
      { method: "POST", body: JSON.stringify({ decision: "allow" }) },
    );
    assert.equal(permissionResponse.status, 202);
    await sse.waitFor("generation.completed", (event) => event.runId === runId);

    const failure = await requestJson(testServer.baseUrl, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "[[error:expected engine failure]]" }),
    });
    await sse.waitFor("generation.failed", (event) => event.runId === failure.body.runId);

    const slow = await requestJson(testServer.baseUrl, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "[[slow:5000]] stop me" }),
    });
    await sse.waitFor("generation.started", (event) => event.runId === slow.body.runId);
    await requestJson(testServer.baseUrl, `/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      body: "{}",
    });
    await sse.waitFor("generation.stopped", (event) => event.runId === slow.body.runId);

    await requestJson(testServer.baseUrl, `/v1/sessions/${sessionId}`, { method: "DELETE" });
    await sse.waitFor("session.deleted", (event) => event.sessionId === sessionId);

    const expected: GatewayEventType[] = [
      "session.created",
      "session.deleted",
      "session.status.changed",
      "message.user",
      "message.assistant.delta",
      "message.assistant.completed",
      "interaction.question",
      "interaction.permission",
      "interaction.resolved",
      "agent.event",
      "generation.started",
      "generation.completed",
      "generation.stopped",
      "generation.failed",
      "error",
    ];
    const received = new Set(sse.events.map((event) => event.type));
    assert.deepEqual(expected.filter((type) => !received.has(type)), []);
  } finally {
    await sse.close();
    await closeServer(testServer.server);
  }
});

test("codeagent and opencode are distinct engines", async () => {
  for (const [engine, prefix] of [
    ["codeagent", "CodeAgent:"],
    ["opencode", "OpenCode:"],
  ] as const) {
    const testServer = await startServer(engine);
    const sse = new SseClient();
    try {
      await sse.connect(`${testServer.baseUrl}/v1/events`);
      const health = await requestJson(testServer.baseUrl, "/health");
      assert.equal(health.body.engine, engine);
      const created = await requestJson(testServer.baseUrl, "/v1/sessions", {
        method: "POST",
        body: "{}",
      });
      const sessionId = created.body.session.id;
      const sent = await requestJson(testServer.baseUrl, `/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
      });
      await sse.waitFor("generation.completed", (event) => event.runId === sent.body.runId);
      const session = await requestJson(testServer.baseUrl, `/v1/sessions/${sessionId}`);
      assert.match(session.body.session.messages.at(-1).content, new RegExp(`^${prefix}`));
    } finally {
      await sse.close();
      await closeServer(testServer.server);
    }
  }
});

test("an engine can be replaced by an external JSONL process bridge", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-bridge-project-"));
  const realProject = await fs.realpath(project);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(
    path.resolve("test/fixtures/bridge.mjs"),
  )}`;
  const { app, service } = createApp({
    engine: "opencode",
    env: { ...process.env, OPENCODE_COMMAND: command },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sse = new SseClient();
  let sessionId: string | undefined;
  try {
    await sse.connect(`${baseUrl}/v1/events`);
    const created = await requestJson(baseUrl, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ directory: project }),
    });
    sessionId = created.body.session.id;
    const sent = await requestJson(baseUrl, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "through bridge" }),
    });
    await sse.waitFor("generation.completed", (event) => event.runId === sent.body.runId);
    const session = await requestJson(baseUrl, `/v1/sessions/${sessionId}`);
    assert.equal(session.body.session.messages.at(-1).content, `bridge:${realProject}:through bridge`);
  } finally {
    if (sessionId) await service.engine.closeSession?.(sessionId);
    await sse.close();
    await closeServer(server);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("ACP adapter maps sessions, elicitation, permission, updates, and cancellation", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-acp-project-"));
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(
    path.resolve("test/fixtures/acp-agent.mjs"),
  )}`;
  const configPath = path.join(project, "agents.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      engines: {
        "fixture-acp": {
          protocol: "acp",
          command,
          displayName: "Fixture ACP Agent",
        },
      },
    }),
  );
  const { app, service } = createApp({
    engine: "fixture-acp",
    env: {
      ...process.env,
      AGENT_ENGINE_CONFIG: configPath,
    },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sse = new SseClient();
  let sessionId: string | undefined;

  try {
    await sse.connect(`${baseUrl}/v1/events`);
    const engines = await requestJson(baseUrl, "/v1/engines");
    assert.equal(engines.body.active, "fixture-acp");
    assert(engines.body.available.includes("fixture-acp"));
    assert.equal(engines.body.capabilities.protocol, "acp");
    assert.equal(engines.body.capabilities.nativeSessions, true);

    const created = await requestJson(baseUrl, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ directory: project }),
    });
    assert.equal(created.status, 201);
    sessionId = created.body.session.id;

    const sent = await requestJson(baseUrl, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "ask and request permission" }),
    });
    const question = await sse.waitFor(
      "interaction.question",
      (event) => event.runId === sent.body.runId,
    );
    assert.deepEqual((question.data as any).choices, ["main", "dev"]);
    await requestJson(
      baseUrl,
      `/v1/sessions/${sessionId}/interactions/${(question.data as any).requestId}/respond`,
      { method: "POST", body: JSON.stringify({ answers: { branch: "main" } }) },
    );

    const permission = await sse.waitFor(
      "interaction.permission",
      (event) => event.runId === sent.body.runId,
    );
    assert.deepEqual(
      (permission.data as any).options.map((option: any) => option.optionId),
      ["allow", "reject"],
    );
    await requestJson(
      baseUrl,
      `/v1/sessions/${sessionId}/interactions/${(permission.data as any).requestId}/respond`,
      { method: "POST", body: JSON.stringify({ optionId: "allow" }) },
    );
    await sse.waitFor("generation.completed", (event) => event.runId === sent.body.runId);

    const firstTurn = await requestJson(baseUrl, `/v1/sessions/${sessionId}`);
    assert.equal(
      firstTurn.body.session.messages.at(-1).content,
      `turn=1;answer=main;permission=allow;cwd=${project}`,
    );
    assert(
      sse.events.some(
        (event) =>
          event.type === "agent.event" &&
          (event.data as any).type === "acp.tool_call",
      ),
    );

    const second = await requestJson(baseUrl, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "second turn" }),
    });
    await sse.waitFor("generation.completed", (event) => event.runId === second.body.runId);
    const secondTurn = await requestJson(baseUrl, `/v1/sessions/${sessionId}`);
    assert.match(secondTurn.body.session.messages.at(-1).content, /^turn=2;/);

    const slow = await requestJson(baseUrl, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "slow" }),
    });
    await sse.waitFor(
      "message.assistant.delta",
      (event) => event.runId === slow.body.runId,
    );
    await requestJson(baseUrl, `/v1/sessions/${sessionId}/stop`, {
      method: "POST",
      body: "{}",
    });
    await sse.waitFor("generation.stopped", (event) => event.runId === slow.body.runId);
    const stopped = await requestJson(baseUrl, `/v1/sessions/${sessionId}`);
    assert.equal(stopped.body.session.status, "idle");

    await requestJson(baseUrl, `/v1/sessions/${sessionId}`, { method: "DELETE" });
  } finally {
    if (sessionId) await service.engine.closeSession?.(sessionId);
    await sse.close();
    await closeServer(server);
    await fs.rm(project, { recursive: true, force: true });
  }
});

test("CLI --engine selects the engine at startup", async () => {
  const child = spawn(
    path.resolve("node_modules/.bin/tsx"),
    ["src/cli.ts", "--engine", "opencode", "--port", "0"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CLI did not start")), 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes("engine=opencode")) {
          clearTimeout(timer);
          resolve(chunk);
        }
      });
      child.once("error", reject);
    });
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert(match);
    const health = await requestJson(`http://127.0.0.1:${match[1]}`, "/health");
    assert.equal(health.body.engine, "opencode");
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "close");
    }
  }
});
