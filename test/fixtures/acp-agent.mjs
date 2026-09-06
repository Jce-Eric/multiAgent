import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map();

function promptText(prompt) {
  return prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

const app = acp
  .agent({ name: "gateway-test-acp-agent" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "gateway-test-acp-agent", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, turn: 0, controller: undefined });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("session not found");
    session.turn += 1;
    session.controller = new AbortController();
    const text = promptText(params.prompt);
    let answer = "none";
    let permission = "none";

    try {
      if (text.includes("ask")) {
        const response = await client.request(acp.methods.client.elicitation.create, {
          mode: "form",
          sessionId: params.sessionId,
          message: "Which branch should be used?",
          requestedSchema: {
            type: "object",
            properties: {
              branch: { type: "string", enum: ["main", "dev"] },
            },
            required: ["branch"],
          },
        });
        if (response.action === "accept") answer = String(response.content?.branch ?? "missing");
      }

      if (text.includes("permission")) {
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "write-readme",
            title: "Write README.md",
            kind: "edit",
            status: "pending",
            rawInput: { path: "README.md" },
          },
        });
        const response = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: "write-readme",
            title: "Write README.md",
            kind: "edit",
            status: "pending",
            rawInput: { path: "README.md" },
          },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject once", kind: "reject_once" },
          ],
        });
        permission = response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled";
      }

      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `turn=${session.turn};answer=${answer};permission=${permission};cwd=${session.cwd}`,
          },
        },
      });

      if (text.includes("slow")) await wait(10_000, session.controller.signal);
      session.controller = undefined;
      return { stopReason: "end_turn" };
    } catch (error) {
      if (session.controller?.signal.aborted) {
        session.controller = undefined;
        return { stopReason: "cancelled" };
      }
      throw error;
    }
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.controller?.abort();
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
app.connect(stream);
