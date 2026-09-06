import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createApp } from "../src/app.js";

const enabled = process.env.RUN_REAL_AGENT_TESTS === "1";

for (const engine of ["codeagent", "opencode", "deepseek-harness"] as const) {
  test(
    `${engine} real runtime creates a session and completes a model turn`,
    { skip: enabled ? false : "Set RUN_REAL_AGENT_TESTS=1 to use credentials and incur model usage" },
    async () => {
      const created = createApp({
        engine,
        env: { ...process.env, LOG_LEVEL: "silent", GENERATION_TIMEOUT_MS: "120000" },
      });
      const server = createServer(created.app);
      const baseUrl = await listen(server);
      let sessionId: string | undefined;
      try {
        const sessionResponse = await json(baseUrl, "/v1/sessions", {
          method: "POST",
          body: JSON.stringify({}),
        });
        assert.equal(sessionResponse.status, 201);
        sessionId = sessionResponse.body.session.id;
        const sent = await json(baseUrl, `/v1/sessions/${sessionId}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "Reply with exactly: OK" }),
        });
        assert.equal(sent.status, 202);
        const session = await waitForIdle(baseUrl, sessionId);
        assert.equal(session.status, "idle");
        assert.equal(session.messages.at(-1)?.role, "assistant");
        assert.match(session.messages.at(-1)?.content ?? "", /OK/i);
      } finally {
        if (sessionId) {
          await json(baseUrl, `/v1/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
        }
        await closeServer(server);
        await created.service.shutdown();
      }
    },
  );
}

async function waitForIdle(baseUrl: string, sessionId: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await json(baseUrl, `/v1/sessions/${sessionId}`);
    if (response.body.session.status === "idle" && response.body.session.messages.length > 1) {
      return response.body.session;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for real Agent response");
}

async function json(baseUrl: string, pathname: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
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
