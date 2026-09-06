import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const threadId = "codex-thread-1";
let turnNumber = 0;
let activeTurn;
const pendingInteractions = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ id, result: value });
}

function notify(method, params) {
  write({ method, params });
}

function turn(id, status = "inProgress", error = null) {
  return {
    id,
    items: [],
    itemsView: { type: "full" },
    status,
    error,
    startedAt: Date.now() / 1000,
    completedAt: status === "inProgress" ? null : Date.now() / 1000,
    durationMs: status === "inProgress" ? null : 1,
  };
}

function completeTurn(questionResult, permissionResult) {
  if (!activeTurn) return;
  const questionAnswer = questionResult?.answers?.branch?.answers?.[0] ?? "missing";
  const decision = permissionResult?.decision ?? "missing";
  const text = `turn=${turnNumber};answer=${questionAnswer};permission=${decision};cwd=${process.cwd()}`;
  notify("item/started", {
    threadId,
    turnId: activeTurn,
    startedAtMs: Date.now(),
    item: {
      type: "commandExecution",
      id: `command-${turnNumber}`,
      command: "pwd",
      cwd: process.cwd(),
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      pluginId: null,
      scriptPath: null,
    },
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId: activeTurn,
    itemId: `message-${turnNumber}`,
    delta: text.slice(0, 10),
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId: activeTurn,
    itemId: `message-${turnNumber}`,
    delta: text.slice(10),
  });
  notify("item/completed", {
    threadId,
    turnId: activeTurn,
    completedAtMs: Date.now(),
    item: {
      type: "agentMessage",
      id: `message-${turnNumber}`,
      text,
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
  });
  notify("turn/completed", {
    threadId,
    turn: turn(activeTurn, "completed"),
  });
  activeTurn = undefined;
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    result(message.id, {
      userAgent: "codex-fixture/1.0",
      codexHome: process.cwd(),
      platformFamily: "unix",
      platformOs: process.platform,
    });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    result(message.id, {
      thread: { id: threadId },
      cwd: message.params.cwd,
    });
    return;
  }
  if (message.method === "thread/delete") {
    result(message.id, {});
    return;
  }
  if (message.method === "turn/start") {
    turnNumber += 1;
    activeTurn = `turn-${turnNumber}`;
    result(message.id, { turn: turn(activeTurn) });
    notify("turn/started", { threadId, turn: turn(activeTurn) });
    const prompt = message.params.input[0].text;
    if (prompt === "slow") {
      notify("item/agentMessage/delta", {
        threadId,
        turnId: activeTurn,
        itemId: `message-${turnNumber}`,
        delta: "partial",
      });
      return;
    }
    const questionId = `question-${turnNumber}`;
    pendingInteractions.set(questionId, { type: "question" });
    write({
      id: questionId,
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId: activeTurn,
        itemId: `tool-${turnNumber}`,
        isBlocking: true,
        autoResolutionMs: null,
        questions: [{
          id: "branch",
          header: "Branch",
          question: "Which branch?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "main", description: "Use main" },
            { label: "dev", description: "Use dev" },
          ],
        }],
      },
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    result(message.id, {});
    if (activeTurn) {
      notify("turn/completed", {
        threadId,
        turn: turn(activeTurn, "interrupted"),
      });
      activeTurn = undefined;
    }
    return;
  }

  if (message.id !== undefined && message.result !== undefined) {
    const pending = pendingInteractions.get(String(message.id));
    if (!pending) return;
    pendingInteractions.delete(String(message.id));
    if (pending.type === "question") {
      const permissionId = `permission-${turnNumber}`;
      pendingInteractions.set(permissionId, {
        type: "permission",
        questionResult: message.result,
      });
      write({
        id: permissionId,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          threadId,
          turnId: activeTurn,
          itemId: `command-${turnNumber}`,
          startedAtMs: Date.now(),
          environmentId: null,
          reason: "Run project checks",
          command: "npm test",
          cwd: process.cwd(),
          commandActions: [],
          availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
        },
      });
    } else {
      completeTurn(pending.questionResult, message.result);
    }
  }
});
