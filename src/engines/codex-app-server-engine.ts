import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { AbortGenerationError, GatewayError } from "../errors.js";
import type { PermissionResponse, QuestionResponse } from "../types.js";
import { deferred, type Deferred } from "../utils.js";
import type { AgentEngine, AgentRunContext, AgentSessionContext } from "./types.js";
import { prependTranscript } from "./transcript.js";

type RpcId = string | number;
type JsonObject = Record<string, unknown>;

interface PendingRequest {
  method: string;
  value: Deferred<unknown>;
  timer?: NodeJS.Timeout;
}

interface ActiveCodexRun {
  context: AgentRunContext;
  completion: Deferred<CodexTurn>;
  turnId?: string;
  output: string;
  fallbackOutput: string;
}

interface CodexRuntime {
  gatewaySessionId: string;
  directory: string;
  child: ChildProcessWithoutNullStreams;
  lines: ReadLineInterface;
  pending: Map<string, PendingRequest>;
  nextRequestId: number;
  stderr: string;
  threadId?: string;
  currentRun?: ActiveCodexRun;
  seedMessages: AgentSessionContext["messages"];
  closing: boolean;
}

interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: {
    message?: string;
    codexErrorInfo?: unknown;
    additionalDetails?: string | null;
  } | null;
}

interface CodexQuestion {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }> | null;
}

interface CodexServerRequest {
  id: RpcId;
  method: string;
  params?: JsonObject;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_STDERR_LENGTH = 64 * 1024;

export class CodexAppServerEngine implements AgentEngine {
  readonly capabilities = {
    protocol: "codex",
    protocolVersion: "app-server-jsonrpc-v2",
    nativeSessions: true,
    questions: true,
    permissions: true,
    cancellation: true,
  } as const;

  private readonly runtimes = new Map<string, CodexRuntime>();

  constructor(
    public readonly name: string,
    private readonly command: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async openSession(context: AgentSessionContext): Promise<void> {
    if (this.runtimes.has(context.sessionId)) return;

    const child = spawn(this.command, {
      cwd: context.directory,
      env: this.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const runtime: CodexRuntime = {
      gatewaySessionId: context.sessionId,
      directory: context.directory,
      child,
      lines: createInterface({ input: child.stdout }),
      pending: new Map(),
      nextRequestId: 1,
      stderr: "",
      seedMessages: context.messages,
      closing: false,
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      runtime.stderr = `${runtime.stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    runtime.lines.on("line", (line) => this.handleLine(runtime, line));
    child.once("error", (error) => this.failRuntime(runtime, error));
    child.once("close", (code, signal) => {
      if (!runtime.closing) {
        this.failRuntime(
          runtime,
          new GatewayError(
            502,
            "ENGINE_PROCESS_ERROR",
            `Codex app-server exited unexpectedly (code ${code ?? "unknown"}, signal ${signal ?? "none"})`,
            runtime.stderr ? { stderr: runtime.stderr.trim() } : undefined,
          ),
        );
      }
    });
    this.runtimes.set(context.sessionId, runtime);

    try {
      const initialized = this.asObject(await this.request(runtime, "initialize", {
        clientInfo: {
          name: "multi-agent-gateway",
          title: "Multi-Agent Gateway",
          version: "0.3.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }));
      if (typeof initialized.userAgent !== "string") {
        throw new GatewayError(
          502,
          "ENGINE_PROTOCOL_ERROR",
          "Codex initialize response did not include userAgent metadata",
        );
      }
      this.notify(runtime, "initialized");
      const started = await this.request(runtime, "thread/start", {
        cwd: context.directory,
        runtimeWorkspaceRoots: [context.directory],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        ephemeral: true,
      }) as { thread?: { id?: string } };
      const threadId = started.thread?.id;
      if (!threadId) {
        throw new GatewayError(
          502,
          "ENGINE_PROTOCOL_ERROR",
          "Codex app-server thread/start response did not include a thread id",
        );
      }
      runtime.threadId = threadId;
    } catch (error) {
      await this.destroyRuntime(runtime, error);
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        502,
        "ENGINE_SESSION_ERROR",
        `Could not initialize Codex app-server: ${this.errorMessage(error)}`,
        runtime.stderr ? { stderr: runtime.stderr.trim() } : undefined,
      );
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    if (runtime.threadId) {
      await this.request(runtime, "thread/delete", { threadId: runtime.threadId }, 2_000)
        .catch(() => undefined);
    }
    await this.destroyRuntime(runtime);
  }

  async generate(prompt: string, context: AgentRunContext): Promise<string> {
    if (!this.runtimes.has(context.sessionId)) {
      await this.openSession({
        sessionId: context.sessionId,
        directory: context.directory,
        messages: context.messages.slice(0, -1),
      });
    }
    const runtime = this.runtimes.get(context.sessionId);
    if (!runtime?.threadId) {
      throw new GatewayError(502, "ENGINE_SESSION_ERROR", "Codex thread is not available");
    }
    if (runtime.currentRun) {
      throw new GatewayError(409, "ENGINE_SESSION_ERROR", "Codex thread is already processing a turn");
    }

    const active: ActiveCodexRun = {
      context,
      completion: deferred<CodexTurn>(),
      output: "",
      fallbackOutput: "",
    };
    runtime.currentRun = active;

    let cancelTimer: NodeJS.Timeout | undefined;
    let interruptSent = false;
    const interrupt = () => {
      if (interruptSent || !active.turnId) return;
      interruptSent = true;
      void this.request(
        runtime,
        "turn/interrupt",
        { threadId: runtime.threadId, turnId: active.turnId },
        2_000,
      ).catch(() => undefined);
    };
    const onAbort = () => {
      interrupt();
      cancelTimer = setTimeout(() => {
        void this.destroyRuntime(runtime, new AbortGenerationError());
      }, 2_000);
      cancelTimer.unref();
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const effectivePrompt = prependTranscript(prompt, runtime.seedMessages);
      runtime.seedMessages = [];
      const response = await this.request(runtime, "turn/start", {
        threadId: runtime.threadId,
        input: [{ type: "text", text: effectivePrompt, text_elements: [] }],
        cwd: context.directory,
        runtimeWorkspaceRoots: [context.directory],
      }) as { turn?: CodexTurn };
      if (!response.turn?.id) {
        throw new GatewayError(
          502,
          "ENGINE_PROTOCOL_ERROR",
          "Codex app-server turn/start response did not include a turn id",
        );
      }
      active.turnId ??= response.turn.id;
      if (context.signal.aborted) interrupt();
      const turn = await active.completion.promise;
      if (context.signal.aborted || turn.status === "interrupted") {
        throw new AbortGenerationError();
      }
      if (turn.status === "failed") {
        throw new GatewayError(
          502,
          "ENGINE_PROCESS_ERROR",
          turn.error?.message ?? "Codex turn failed",
          turn.error ?? undefined,
        );
      }
      return active.output || active.fallbackOutput;
    } catch (error) {
      if (context.signal.aborted) throw new AbortGenerationError();
      throw error;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (cancelTimer) clearTimeout(cancelTimer);
      if (runtime.currentRun === active) runtime.currentRun = undefined;
    }
  }

  private handleLine(runtime: CodexRuntime, line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.failRuntime(
        runtime,
        new GatewayError(502, "ENGINE_PROTOCOL_ERROR", "Codex app-server emitted invalid JSON", {
          line,
        }),
      );
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      this.handleResponse(runtime, message);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      void this.handleServerRequest(runtime, message as unknown as CodexServerRequest);
      return;
    }
    this.handleNotification(runtime, message.method, this.asObject(message.params));
  }

  private handleResponse(runtime: CodexRuntime, message: JsonObject): void {
    const pending = runtime.pending.get(String(message.id));
    if (!pending) return;
    runtime.pending.delete(String(message.id));
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = this.asObject(message.error);
      pending.value.reject(
        new GatewayError(
          502,
          "ENGINE_PROTOCOL_ERROR",
          `Codex ${pending.method} failed: ${String(error.message ?? "unknown JSON-RPC error")}`,
          error,
        ),
      );
    } else {
      pending.value.resolve(message.result);
    }
  }

  private handleNotification(runtime: CodexRuntime, method: string, params: JsonObject): void {
    const active = runtime.currentRun;
    if (!active || !this.matchesActiveRun(runtime, params)) return;
    active.context.emitEvent(`codex.${method}`, params);

    if (method === "turn/started") {
      const turn = this.asObject(params.turn);
      if (typeof turn.id === "string") active.turnId ??= turn.id;
      return;
    }
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      active.output += params.delta;
      active.context.emitDelta(params.delta);
      return;
    }
    if (method === "item/completed") {
      const item = this.asObject(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        active.fallbackOutput = item.text;
      }
      return;
    }
    if (method === "error" && params.willRetry !== true) {
      const error = this.asObject(params.error);
      active.completion.reject(
        new GatewayError(
          502,
          "ENGINE_PROCESS_ERROR",
          typeof error.message === "string" ? error.message : "Codex turn failed",
          error,
        ),
      );
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn as unknown as CodexTurn;
      active.completion.resolve(turn);
    }
  }

  private async handleServerRequest(runtime: CodexRuntime, request: CodexServerRequest): Promise<void> {
    try {
      const result = await this.dispatchServerRequest(runtime, request.method, request.params ?? {});
      this.write(runtime, { id: request.id, result });
    } catch (error) {
      this.write(runtime, {
        id: request.id,
        error: { code: -32603, message: this.errorMessage(error) },
      });
    }
  }

  private async dispatchServerRequest(
    runtime: CodexRuntime,
    method: string,
    params: JsonObject,
  ): Promise<unknown> {
    const active = runtime.currentRun;
    if (!active || !this.matchesActiveRun(runtime, params)) {
      return this.cancelledResponse(method);
    }
    active.context.emitEvent(`codex.${method}`, params);

    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions as CodexQuestion[] : [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of questions) {
        const response = await active.context.askQuestion({
          question: question.question,
          choices: question.options?.map((option) => option.label),
          metadata: { method, header: question.header, question, request: params },
        });
        answers[question.id] = { answers: this.answerValues(response, question.id) };
      }
      return { answers };
    }

    if (method === "mcpServer/elicitation/request") {
      if (params.mode === "url") {
        await active.context.askQuestion({
          question: `${String(params.message ?? "Open the requested URL")}\n${String(params.url ?? "")}`,
          metadata: { method, request: params },
        });
        return { action: "accept", content: null, _meta: null };
      }
      const schema = this.asObject(params.requestedSchema);
      const properties = this.asObject(schema.properties);
      const required = Array.isArray(schema.required) ? schema.required : [];
      const key = String(required[0] ?? Object.keys(properties)[0] ?? "answer");
      const property = this.asObject(properties[key]);
      const choices = Array.isArray(property.enum)
        ? property.enum.filter((value): value is string => typeof value === "string")
        : undefined;
      const response = await active.context.askQuestion({
        question: String(params.message ?? "Input required"),
        choices,
        schema,
        metadata: { method, request: params },
      });
      return {
        action: "accept",
        content: response.answers ?? { [key]: response.answer ?? "" },
        _meta: null,
      };
    }

    if (method === "item/commandExecution/requestApproval") {
      const available = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : ["accept", "acceptForSession", "decline", "cancel"];
      const decisions = available.filter((value): value is string => typeof value === "string");
      const response = await active.context.requestPermission({
        operation: String(params.command ?? params.kind ?? "execute command"),
        reason: this.joinReason(params.reason, params.cwd),
        options: decisions.map((decision) => ({
          optionId: decision,
          name: this.decisionLabel(decision),
          kind: decision.startsWith("accept") ? "allow" : "reject",
        })),
        metadata: { method, request: params },
      });
      return { decision: this.selectDecision(response, decisions, "accept", "decline") };
    }

    if (method === "item/fileChange/requestApproval") {
      const decisions = ["accept", "acceptForSession", "decline", "cancel"];
      const response = await active.context.requestPermission({
        operation: params.grantRoot
          ? `write files under ${String(params.grantRoot)}`
          : "apply file changes",
        reason: typeof params.reason === "string" ? params.reason : undefined,
        options: decisions.map((decision) => ({
          optionId: decision,
          name: this.decisionLabel(decision),
          kind: decision.startsWith("accept") ? "allow" : "reject",
        })),
        metadata: { method, request: params },
      });
      return { decision: this.selectDecision(response, decisions, "accept", "decline") };
    }

    if (method === "item/permissions/requestApproval") {
      const requested = this.asObject(params.permissions);
      const response = await active.context.requestPermission({
        operation: "grant additional Codex permissions",
        reason: typeof params.reason === "string" ? params.reason : undefined,
        options: [
          { optionId: "allow-turn", name: "Allow for this turn", kind: "allow_once" },
          { optionId: "allow-session", name: "Allow for this session", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        metadata: { method, request: params },
      });
      const allowed = response.decision === "allow" || response.optionId?.startsWith("allow");
      return {
        permissions: allowed
          ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value != null))
          : {},
        scope: response.optionId === "allow-session" ? "session" : "turn",
      };
    }

    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      const operation = method === "execCommandApproval"
        ? (Array.isArray(params.command) ? params.command.join(" ") : "execute command")
        : "apply file changes";
      const response = await active.context.requestPermission({
        operation,
        reason: typeof params.reason === "string" ? params.reason : undefined,
        options: [
          { optionId: "approved", name: "Allow once", kind: "allow_once" },
          { optionId: "approved_for_session", name: "Allow for session", kind: "allow_always" },
          { optionId: "denied", name: "Deny", kind: "reject_once" },
        ],
        metadata: { method, request: params },
      });
      const decision = response.optionId === "approved_for_session"
        ? "approved_for_session"
        : response.decision === "allow" || response.optionId === "approved"
          ? "approved"
          : { denied: { rejection: "Denied by gateway client" } };
      return { decision };
    }

    throw new GatewayError(
      502,
      "ENGINE_PROTOCOL_ERROR",
      `Unsupported Codex app-server request '${method}'`,
    );
  }

  private request(
    runtime: CodexRuntime,
    method: string,
    params?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (runtime.closing) {
      return Promise.reject(new GatewayError(502, "ENGINE_PROCESS_ERROR", "Codex app-server is closed"));
    }
    const id = runtime.nextRequestId++;
    const value = deferred<unknown>();
    const pending: PendingRequest = { method, value };
    if (timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        runtime.pending.delete(String(id));
        value.reject(
          new GatewayError(504, "ENGINE_PROCESS_ERROR", `Codex ${method} request timed out`),
        );
      }, timeoutMs);
      pending.timer.unref();
    }
    runtime.pending.set(String(id), pending);
    try {
      this.write(runtime, { id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      runtime.pending.delete(String(id));
      if (pending.timer) clearTimeout(pending.timer);
      value.reject(error);
    }
    return value.promise;
  }

  private notify(runtime: CodexRuntime, method: string, params?: unknown): void {
    this.write(runtime, { method, ...(params === undefined ? {} : { params }) });
  }

  private write(runtime: CodexRuntime, message: unknown): void {
    if (runtime.closing || runtime.child.stdin.destroyed) {
      throw new GatewayError(502, "ENGINE_PROCESS_ERROR", "Codex app-server stdin is closed");
    }
    runtime.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failRuntime(runtime: CodexRuntime, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const pending of runtime.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.value.reject(normalized);
    }
    runtime.pending.clear();
    runtime.currentRun?.completion.reject(normalized);
    void this.destroyRuntime(runtime, normalized);
  }

  private async destroyRuntime(runtime: CodexRuntime, reason?: unknown): Promise<void> {
    if (runtime.closing) return;
    runtime.closing = true;
    this.runtimes.delete(runtime.gatewaySessionId);
    runtime.lines.close();
    const error = reason instanceof Error ? reason : new AbortGenerationError();
    for (const pending of runtime.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.value.reject(error);
    }
    runtime.pending.clear();
    runtime.currentRun?.completion.reject(error);
    runtime.child.stdin.end();
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill("SIGTERM");
      const timer = setTimeout(() => runtime.child.kill("SIGKILL"), 1_000);
      timer.unref();
      await waitForExit(runtime.child, 2_000);
      clearTimeout(timer);
    }
  }

  private matchesActiveRun(runtime: CodexRuntime, params: JsonObject): boolean {
    if (runtime.threadId && typeof params.threadId === "string" && params.threadId !== runtime.threadId) {
      return false;
    }
    const turnId = runtime.currentRun?.turnId;
    return !(turnId && typeof params.turnId === "string" && params.turnId !== turnId);
  }

  private cancelledResponse(method: string): unknown {
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request") {
      return { action: "cancel", content: null, _meta: null };
    }
    if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      return { decision: "abort" };
    }
    return { decision: "cancel" };
  }

  private answerValues(response: QuestionResponse, questionId: string): string[] {
    const value = response.answers?.[questionId] ?? response.answer;
    if (Array.isArray(value)) return value.map(String);
    return value === undefined ? [] : [String(value)];
  }

  private selectDecision(
    response: PermissionResponse,
    decisions: string[],
    allowFallback: string,
    denyFallback: string,
  ): string {
    if (response.optionId && decisions.includes(response.optionId)) return response.optionId;
    const preferred = response.decision === "allow" ? allowFallback : denyFallback;
    if (decisions.includes(preferred)) return preferred;
    return decisions[0] ?? "cancel";
  }

  private decisionLabel(decision: string): string {
    const labels: Record<string, string> = {
      accept: "Allow once",
      acceptForSession: "Allow for session",
      decline: "Deny",
      cancel: "Cancel turn",
    };
    return labels[decision] ?? decision;
  }

  private joinReason(reason: unknown, cwd: unknown): string | undefined {
    const values = [reason, typeof cwd === "string" ? `cwd: ${cwd}` : undefined]
      .filter((value): value is string => typeof value === "string" && Boolean(value));
    return values.length ? values.join("\n") : undefined;
  }

  private asObject(value: unknown): JsonObject {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonObject
      : {};
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
