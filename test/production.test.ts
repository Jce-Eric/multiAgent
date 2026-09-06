import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { SqliteRunRepository } from "../src/run-store.js";
import { SqliteSessionRepository } from "../src/session-store.js";
import type { EventBus } from "../src/event-bus.js";
import type { GatewayEvent, GatewayEventType, Session } from "../src/types.js";

const referenceEnv = {
  ...process.env,
  CODEAGENT_PROTOCOL: "reference",
  OPENCODE_PROTOCOL: "reference",
  LOG_LEVEL: "silent",
};

test("SQLite persists sessions and recovers busy state as idle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-persistence-"));
  const databasePath = path.join(root, "gateway.db");
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const env = { ...referenceEnv, GATEWAY_DATABASE_PATH: databasePath };
  let sessionId = "";
  try {
    const first = createApp({ engine: "codeagent", env });
    const session = await first.service.createSession(project);
    sessionId = session.id;
    const run = first.service.sendMessage(session.id, "persistent message");
    await waitForEvent(first.service.events, "generation.completed", (event) => event.runId === run.runId);
    await first.service.shutdown();

    const second = createApp({ engine: "codeagent", env });
    const restored = second.service.getSession(session.id);
    assert.equal(restored.status, "idle");
    assert.equal(restored.messages[0].content, "persistent message");
    assert.match(restored.messages[1].content, /^CodeAgent:/);
    await second.service.deleteSession(session.id);
    await second.service.shutdown();

    const repository = new SqliteSessionRepository(databasePath);
    const timestamp = new Date().toISOString();
    repository.add({
      id: "busy-session",
      engine: "codeagent",
      directory: project,
      status: "busy",
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    repository.close();
    const reopened = new SqliteSessionRepository(databasePath);
    assert.equal(reopened.get("busy-session").status, "idle");
    reopened.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SQLite persists runs and replayable gateway events across restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-durable-events-"));
  const databasePath = path.join(root, "gateway.db");
  const env = { ...referenceEnv, GATEWAY_DATABASE_PATH: databasePath };
  try {
    const first = createApp({ engine: "codeagent", env });
    const session = await first.service.createSession(root);
    const accepted = first.service.sendMessage(session.id, "durable run");
    const completed = await waitForEvent(
      first.service.events,
      "generation.completed",
      (event) => event.runId === accepted.runId,
    );
    const originalRun = first.service.getRun(accepted.runId);
    assert.equal(originalRun.status, "completed");
    await first.service.shutdown();

    const second = createApp({ engine: "opencode", env });
    const restored = second.service.getRun(accepted.runId);
    assert.equal(restored.status, "completed");
    assert.equal(restored.engine, "codeagent");
    assert(second.service.events.eventsAfter(0).some((event) => event.id === completed.id));
    const resumed = second.service.sendMessage(session.id, "route restored session");
    await waitForEvent(
      second.service.events,
      "generation.completed",
      (event) => event.runId === resumed.runId,
    );
    assert.equal(second.service.getRun(resumed.runId).engine, "codeagent");
    const next = await second.service.createSession(root, "opencode");
    const nextEvent = second.service.events.eventsAfter(completed.id).find(
      (event) => event.sessionId === next.id && event.type === "session.created",
    );
    assert(nextEvent && nextEvent.id > completed.id);
    await second.service.shutdown();

    const interrupted = new SqliteRunRepository(databasePath);
    const timestamp = new Date().toISOString();
    interrupted.add({
      id: "interrupted-run",
      sessionId: "missing-session",
      engine: "codeagent",
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    interrupted.close();
    const recovered = new SqliteRunRepository(databasePath);
    assert.equal(recovered.get("interrupted-run").status, "failed");
    assert.equal(recovered.get("interrupted-run").error?.code, "GATEWAY_RESTARTED");
    recovered.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("allowed roots reject direct and symlink directory escapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-roots-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await Promise.all([fs.mkdir(allowed), fs.mkdir(outside)]);
  await fs.symlink(outside, path.join(allowed, "escape"));
  const { service } = createApp({
    engine: "codeagent",
    env: { ...referenceEnv, AGENT_ALLOWED_ROOTS: allowed },
  });
  try {
    const session = await service.createSession(allowed);
    assert.equal(session.directory, await fs.realpath(allowed));
    await assert.rejects(
      service.createSession(outside),
      (error: any) => error?.code === "DIRECTORY_NOT_ALLOWED",
    );
    await assert.rejects(
      service.createSession(path.join(allowed, "escape")),
      (error: any) => error?.code === "DIRECTORY_NOT_ALLOWED",
    );
  } finally {
    await service.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("API key protects v1 and metrics while health and readiness remain public", async () => {
  const created = createApp({
    engine: "codeagent",
    env: { ...referenceEnv, GATEWAY_API_KEY: "test-secret" },
  });
  const server = createServer(created.app);
  const baseUrl = await listen(server);
  try {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/openapi.yaml`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/asyncapi.yaml`)).status, 200);
    const denied = await fetch(`${baseUrl}/v1/engines`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json() as any).error.code, "UNAUTHORIZED");
    const authorized = await fetch(`${baseUrl}/v1/engines`, {
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
    const metrics = await fetch(`${baseUrl}/metrics`, {
      headers: { "x-api-key": "test-secret" },
    });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /multi_agent_gateway_http_requests_total/);
  } finally {
    await closeServer(server);
    await created.service.shutdown();
  }
});

test("resource limits, generation timeout, and permission policy are enforced", async () => {
  const { service } = createApp({
    engine: "codeagent",
    env: referenceEnv,
    config: {
      generationTimeoutMs: 25,
      maxConcurrentRuns: 1,
      maxMessagesPerSession: 2,
      maxSessions: 2,
      permissionPolicy: "allow",
    },
  });
  try {
    const first = await service.createSession();
    const second = await service.createSession();
    await assert.rejects(service.createSession(), (error: any) => error?.code === "RESOURCE_LIMIT");
    const slow = service.sendMessage(first.id, "[[slow:5000]]");
    assert.throws(
      () => service.sendMessage(second.id, "blocked by concurrency"),
      (error: any) => error?.code === "RESOURCE_LIMIT",
    );
    const timedOut = await waitForEvent(
      service.events,
      "generation.failed",
      (event) => event.runId === slow.runId,
    );
    assert.equal((timedOut.data as any).code, "GENERATION_TIMEOUT");

    const permissionRun = service.sendMessage(second.id, "[[permission:write file]]");
    await waitForEvent(
      service.events,
      "generation.completed",
      (event) => event.runId === permissionRun.runId,
    );
    const resolved = service.events.eventsAfter(0, second.id).find(
      (event) => event.type === "interaction.resolved",
    );
    assert.equal((resolved?.data as any).resolvedBy, "policy");
    assert.throws(
      () => service.sendMessage(second.id, "message limit"),
      (error: any) => error?.code === "RESOURCE_LIMIT",
    );
  } finally {
    await service.shutdown();
  }
});

test("idle ACP runtimes reopen with persisted conversation context", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-idle-acp-"));
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(
    path.resolve("test/fixtures/acp-agent.mjs"),
  )}`;
  const { service } = createApp({
    engine: "opencode",
    env: { ...process.env, OPENCODE_COMMAND: command, LOG_LEVEL: "silent" },
    config: { idleSessionTimeoutMs: 20 },
  });
  try {
    const session = await service.createSession(project);
    const first = service.sendMessage(session.id, "first turn");
    await waitForEvent(service.events, "generation.completed", (event) => event.runId === first.runId);
    await waitForEvent(
      service.events,
      "agent.event",
      (event) => (event.data as any).type === "gateway.runtime.closed",
    );
    const second = service.sendMessage(session.id, "check restoration");
    await waitForEvent(service.events, "generation.completed", (event) => event.runId === second.runId);
    assert.match(service.getSession(session.id).messages.at(-1)?.content ?? "", /restored=true$/);
  } finally {
    await service.shutdown();
    await fs.rm(project, { recursive: true, force: true });
  }
});

async function waitForEvent(
  events: EventBus,
  type: GatewayEventType,
  predicate: (event: GatewayEvent) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<GatewayEvent> {
  const existing = events.eventsAfter(0).find((event) => event.type === type && predicate(event));
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const unsubscribe = events.subscribe((event) => {
      if (event.type !== type || !predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}
