import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AbortGenerationError, GatewayError } from "../errors.js";
import type { PermissionResponse, QuestionResponse } from "../types.js";
import type { AgentEngine, AgentRunContext, AgentSessionContext } from "./types.js";
import { prependTranscript } from "./transcript.js";

interface ActiveAcpRun {
  context: AgentRunContext;
  output: string;
}

interface AcpRuntime {
  gatewaySessionId: string;
  directory: string;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  session?: acp.ActiveSession;
  currentRun?: ActiveAcpRun;
  seedMessages: AgentSessionContext["messages"];
  closing: boolean;
}

export class AcpEngine implements AgentEngine {
  readonly capabilities = {
    protocol: "acp",
    protocolVersion: String(acp.PROTOCOL_VERSION),
    nativeSessions: true,
    questions: true,
    permissions: true,
    cancellation: true,
  } as const;

  private readonly runtimes = new Map<string, AcpRuntime>();

  constructor(
    public readonly name: string,
    private readonly command: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly cancelGraceMilliseconds = 2_000,
  ) {}

  async openSession(context: AgentSessionContext): Promise<void> {
    if (this.runtimes.has(context.sessionId)) return;

    const child = spawn(this.command, {
      cwd: context.directory,
      env: this.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let runtime!: AcpRuntime;
    const client = acp
      .client({ name: "multi-agent-gateway" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        this.handlePermission(runtime, params),
      )
      .onRequest(acp.methods.client.elicitation.create, ({ params }) =>
        this.handleElicitation(runtime, params),
      );

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = client.connect(stream);
    runtime = {
      gatewaySessionId: context.sessionId,
      directory: context.directory,
      child,
      connection,
      seedMessages: context.messages,
      closing: false,
    };

    child.once("error", (error) => connection.close(error));
    child.once("close", (code, signal) => {
      if (!runtime.closing) {
        connection.close(
          new GatewayError(
            502,
            "ENGINE_PROCESS_ERROR",
            `ACP agent exited unexpectedly (code ${code ?? "unknown"}, signal ${signal ?? "none"})`,
            stderr ? { stderr: stderr.trim() } : undefined,
          ),
        );
      }
      if (this.runtimes.get(context.sessionId) === runtime) {
        this.runtimes.delete(context.sessionId);
      }
    });

    try {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { elicitation: { form: {} } },
        clientInfo: { name: "multi-agent-gateway", version: "0.2.0" },
      });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new GatewayError(
          502,
          "ENGINE_PROTOCOL_ERROR",
          `ACP protocol version ${initialized.protocolVersion} is not supported`,
        );
      }

      runtime.session = await connection.agent.buildSession(context.directory).start();
      this.runtimes.set(context.sessionId, runtime);
    } catch (error) {
      await this.destroyRuntime(runtime);
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        502,
        "ENGINE_SESSION_ERROR",
        `Could not initialize ACP agent: ${error instanceof Error ? error.message : "unknown error"}`,
        stderr ? { stderr: stderr.trim() } : undefined,
      );
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) await this.destroyRuntime(runtime);
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
    if (!runtime?.session) {
      throw new GatewayError(502, "ENGINE_SESSION_ERROR", "ACP session is not available");
    }
    if (runtime.currentRun) {
      throw new GatewayError(409, "ENGINE_SESSION_ERROR", "ACP session is already processing a turn");
    }

    runtime.currentRun = { context, output: "" };
    let cancelTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      void runtime.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: runtime.session!.sessionId,
      });
      cancelTimer = setTimeout(() => {
        void this.destroyRuntime(runtime, new AbortGenerationError());
      }, this.cancelGraceMilliseconds);
      cancelTimer.unref();
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const effectivePrompt = prependTranscript(prompt, runtime.seedMessages);
      runtime.seedMessages = [];
      const promptResult = runtime.session.prompt(effectivePrompt);
      void promptResult.catch(() => undefined);
      for (;;) {
        const message = await runtime.session.nextUpdate();
        if (message.kind === "session_update") {
          this.handleSessionUpdate(runtime, message.notification);
          continue;
        }
        context.emitEvent("acp.stop", {
          stopReason: message.stopReason,
          usage: message.response.usage,
        });
        if (context.signal.aborted || message.stopReason === "cancelled") {
          throw new AbortGenerationError();
        }
        return runtime.currentRun.output;
      }
    } catch (error) {
      if (context.signal.aborted) throw new AbortGenerationError();
      throw error;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (cancelTimer) clearTimeout(cancelTimer);
      runtime.currentRun = undefined;
    }
  }

  private handleSessionUpdate(runtime: AcpRuntime, notification: acp.SessionNotification): void {
    const active = runtime.currentRun;
    if (!active || notification.sessionId !== runtime.session?.sessionId) return;
    const update = notification.update;
    active.context.emitEvent(`acp.${update.sessionUpdate}`, update);
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      active.output += update.content.text;
      active.context.emitDelta(update.content.text);
    }
  }

  private async handlePermission(
    runtime: AcpRuntime,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const active = runtime.currentRun;
    if (!active || request.sessionId !== runtime.session?.sessionId) {
      return { outcome: { outcome: "cancelled" } };
    }

    let response: PermissionResponse;
    try {
      response = await active.context.requestPermission({
        operation: request.toolCall.title ?? request.toolCall.toolCallId,
        reason: this.describeToolCall(request.toolCall),
        options: request.options,
        metadata: request,
      });
    } catch (error) {
      if (active.context.signal.aborted) {
        return { outcome: { outcome: "cancelled" } };
      }
      throw error;
    }

    const selected = response.optionId
      ? request.options.find((option) => option.optionId === response.optionId)
      : request.options.find((option) =>
          response.decision === "allow"
            ? option.kind === "allow_once" || option.kind === "allow_always"
            : option.kind === "reject_once" || option.kind === "reject_always",
        );
    return selected
      ? { outcome: { outcome: "selected", optionId: selected.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  private async handleElicitation(
    runtime: AcpRuntime,
    request: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    const active = runtime.currentRun;
    if (!active || request.mode !== "form") return { action: "decline" };
    if ("sessionId" in request && request.sessionId !== runtime.session?.sessionId) {
      return { action: "decline" };
    }

    const requestedSchema = (request as { requestedSchema: acp.ElicitationSchema }).requestedSchema;
    const properties = requestedSchema.properties ?? {};
    const firstProperty = requestedSchema.required?.[0] ?? Object.keys(properties)[0] ?? "answer";
    const schema = properties[firstProperty];
    const choices =
      schema && schema.type === "string" && "enum" in schema && Array.isArray(schema.enum)
        ? schema.enum
        : undefined;

    let response: QuestionResponse;
    try {
      response = await active.context.askQuestion({
        question: request.message,
        choices,
        schema: requestedSchema,
        metadata: request,
      });
    } catch (error) {
      if (active.context.signal.aborted) return { action: "cancel" };
      throw error;
    }

    const content =
      response.answers ??
      (response.answer === undefined ? undefined : { [firstProperty]: response.answer });
    return content ? { action: "accept", content } : { action: "decline" };
  }

  private describeToolCall(toolCall: acp.ToolCallUpdate): string | undefined {
    if (toolCall.rawInput === undefined) return undefined;
    try {
      return JSON.stringify(toolCall.rawInput);
    } catch {
      return "ACP tool call requires permission";
    }
  }

  private async destroyRuntime(runtime: AcpRuntime, error?: unknown): Promise<void> {
    if (runtime.closing) return;
    runtime.closing = true;
    this.runtimes.delete(runtime.gatewaySessionId);
    runtime.session?.dispose();
    runtime.connection.close(error);
    runtime.child.stdin.end();
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      runtime.child.kill("SIGTERM");
      const timer = setTimeout(() => runtime.child.kill("SIGKILL"), 1_000);
      timer.unref();
      await waitForExit(runtime.child, 2_000);
      clearTimeout(timer);
    }
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
