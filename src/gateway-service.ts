import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { EventBus } from "./event-bus.js";
import { AbortGenerationError, GatewayError, isAbortError } from "./errors.js";
import { SessionStore } from "./session-store.js";
import type {
  InteractionType,
  Message,
  PermissionResponse,
  QuestionResponse,
  Session,
} from "./types.js";
import { deferred, now, type Deferred } from "./utils.js";
import type { AgentEngine, PermissionInput, QuestionInput } from "./engines/types.js";

type InteractionResponse = QuestionResponse | PermissionResponse;

interface PendingInteraction {
  id: string;
  type: InteractionType;
  value: Deferred<InteractionResponse>;
}

interface ActiveRun {
  id: string;
  controller: AbortController;
  interactions: Map<string, PendingInteraction>;
  finished: Deferred<void>;
}

export class GatewayService {
  private readonly sessions = new SessionStore();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(
    readonly engine: AgentEngine,
    readonly events = new EventBus(),
    private readonly defaultDirectory = process.cwd(),
  ) {}

  async createSession(directory?: string): Promise<Session> {
    const resolvedDirectory = await this.resolveDirectory(directory);
    const timestamp = now();
    const session: Session = {
      id: randomUUID(),
      engine: this.engine.name,
      directory: resolvedDirectory,
      status: "idle",
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.engine.openSession?.({ sessionId: session.id, directory: session.directory });
    this.sessions.add(session);
    this.events.publish("session.created", this.snapshot(session), { sessionId: session.id });
    return this.snapshot(session);
  }

  listSessions(): Session[] {
    return this.sessions.list().map((session) => this.snapshot(session));
  }

  getSession(id: string): Session {
    return this.snapshot(this.sessions.get(id));
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    const run = this.activeRuns.get(id);
    if (run) {
      this.stopSession(id);
      await run.finished.promise;
    }
    await this.engine.closeSession?.(id);
    this.sessions.delete(id);
    this.events.publish("session.deleted", { id: session.id }, { sessionId: session.id });
  }

  sendMessage(sessionId: string, content: string): { runId: string } {
    const session = this.sessions.get(sessionId);
    if (session.status === "busy") {
      throw new GatewayError(409, "SESSION_BUSY", `Session '${sessionId}' is already busy`);
    }

    const userMessage = this.createMessage("user", content, "completed");
    session.messages.push(userMessage);
    session.updatedAt = now();

    const run: ActiveRun = {
      id: randomUUID(),
      controller: new AbortController(),
      interactions: new Map(),
      finished: deferred<void>(),
    };
    this.activeRuns.set(sessionId, run);
    this.setStatus(session, "busy", run.id);
    this.events.publish("message.user", userMessage, { sessionId, runId: run.id });
    this.events.publish(
      "generation.started",
      { engine: this.engine.name, directory: session.directory },
      { sessionId, runId: run.id },
    );

    void this.executeRun(session, run, content);
    return { runId: run.id };
  }

  respondToInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
  ): void {
    this.sessions.get(sessionId);
    const run = this.activeRuns.get(sessionId);
    const interaction = run?.interactions.get(requestId);
    if (!run || !interaction) {
      throw new GatewayError(
        404,
        "INTERACTION_NOT_FOUND",
        `Interaction '${requestId}' was not found`,
      );
    }

    if (interaction.type === "question") {
      const questionResponse = response as QuestionResponse;
      const hasAnswer =
        typeof questionResponse.answer === "string" && Boolean(questionResponse.answer.trim());
      const hasAnswers =
        questionResponse.answers !== undefined &&
        typeof questionResponse.answers === "object" &&
        questionResponse.answers !== null &&
        Object.keys(questionResponse.answers).length > 0;
      if (!(hasAnswer || hasAnswers)) {
        throw new GatewayError(
          400,
          "INTERACTION_RESPONSE_INVALID",
          "Question responses require a non-empty 'answer' or 'answers' object",
        );
      }
    } else {
      const permissionResponse = response as PermissionResponse;
      if (
        permissionResponse.optionId === undefined &&
        permissionResponse.decision !== "allow" &&
        permissionResponse.decision !== "deny"
      ) {
        throw new GatewayError(
          400,
          "INTERACTION_RESPONSE_INVALID",
          "Permission responses require decision 'allow'/'deny' or an 'optionId'",
        );
      }
    }

    run.interactions.delete(requestId);
    interaction.value.resolve(response);
    this.events.publish(
      "interaction.resolved",
      { requestId, interactionType: interaction.type, response },
      { sessionId, runId: run.id },
    );
  }

  stopSession(sessionId: string): { runId: string } {
    const session = this.sessions.get(sessionId);
    const run = this.activeRuns.get(sessionId);
    if (!run || session.status !== "busy") {
      throw new GatewayError(409, "SESSION_IDLE", `Session '${sessionId}' is not generating`);
    }

    run.controller.abort();
    for (const interaction of run.interactions.values()) {
      interaction.value.reject(new AbortGenerationError());
    }
    run.interactions.clear();
    return { runId: run.id };
  }

  private async executeRun(session: Session, run: ActiveRun, prompt: string): Promise<void> {
    let accumulated = "";
    try {
      const result = await this.engine.generate(prompt, {
        sessionId: session.id,
        runId: run.id,
        directory: session.directory,
        messages: session.messages,
        signal: run.controller.signal,
        emitDelta: (text) => {
          if (!text || run.controller.signal.aborted) return;
          accumulated += text;
          this.events.publish("message.assistant.delta", { delta: text }, {
            sessionId: session.id,
            runId: run.id,
          });
        },
        askQuestion: (input) => this.createQuestion(session, run, input),
        requestPermission: (input) => this.createPermission(session, run, input),
        emitEvent: (type, data) => {
          if (run.controller.signal.aborted) return;
          this.events.publish("agent.event", { type, data }, {
            sessionId: session.id,
            runId: run.id,
          });
        },
      });

      if (run.controller.signal.aborted) {
        throw new AbortGenerationError();
      }
      if (!accumulated && result) {
        accumulated = result;
        this.events.publish("message.assistant.delta", { delta: result }, {
          sessionId: session.id,
          runId: run.id,
        });
      }

      const message = this.createMessage("assistant", accumulated, "completed");
      session.messages.push(message);
      session.updatedAt = now();
      this.events.publish("message.assistant.completed", message, {
        sessionId: session.id,
        runId: run.id,
      });
      this.events.publish("generation.completed", { messageId: message.id }, {
        sessionId: session.id,
        runId: run.id,
      });
    } catch (error) {
      if (isAbortError(error) || run.controller.signal.aborted) {
        if (accumulated) {
          const message = this.createMessage("assistant", accumulated, "stopped");
          session.messages.push(message);
          this.events.publish("message.assistant.completed", message, {
            sessionId: session.id,
            runId: run.id,
          });
        }
        this.events.publish("generation.stopped", { partialContent: accumulated }, {
          sessionId: session.id,
          runId: run.id,
        });
      } else {
        const normalized = this.normalizeEngineError(error);
        this.events.publish("error", normalized, { sessionId: session.id, runId: run.id });
        this.events.publish("generation.failed", normalized, {
          sessionId: session.id,
          runId: run.id,
        });
      }
    } finally {
      for (const interaction of run.interactions.values()) {
        interaction.value.reject(new AbortGenerationError());
      }
      run.interactions.clear();
      if (this.activeRuns.get(session.id)?.id === run.id) {
        this.activeRuns.delete(session.id);
      }
      this.setStatus(session, "idle", run.id);
      run.finished.resolve();
    }
  }

  private async createQuestion(
    session: Session,
    run: ActiveRun,
    input: QuestionInput,
  ): Promise<QuestionResponse> {
    const interaction = this.registerInteraction(run, "question");
    this.events.publish(
      "interaction.question",
      {
        requestId: interaction.id,
        question: input.question,
        choices: input.choices,
        schema: input.schema,
        metadata: input.metadata,
      },
      { sessionId: session.id, runId: run.id },
    );
    return interaction.value.promise as Promise<QuestionResponse>;
  }

  private async createPermission(
    session: Session,
    run: ActiveRun,
    input: PermissionInput,
  ): Promise<PermissionResponse> {
    const interaction = this.registerInteraction(run, "permission");
    this.events.publish(
      "interaction.permission",
      {
        requestId: interaction.id,
        operation: input.operation,
        reason: input.reason,
        options: input.options,
        metadata: input.metadata,
      },
      { sessionId: session.id, runId: run.id },
    );
    return interaction.value.promise as Promise<PermissionResponse>;
  }

  private registerInteraction(run: ActiveRun, type: InteractionType): PendingInteraction {
    if (run.controller.signal.aborted) {
      throw new AbortGenerationError();
    }
    const interaction: PendingInteraction = {
      id: randomUUID(),
      type,
      value: deferred<InteractionResponse>(),
    };
    run.interactions.set(interaction.id, interaction);
    return interaction;
  }

  private setStatus(session: Session, status: Session["status"], runId?: string): void {
    if (session.status === status) return;
    const previous = session.status;
    session.status = status;
    session.updatedAt = now();
    this.events.publish("session.status.changed", { previous, status }, {
      sessionId: session.id,
      runId,
    });
  }

  private async resolveDirectory(directory?: string): Promise<string> {
    const resolved = path.resolve(directory ?? this.defaultDirectory);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GatewayError(400, "DIRECTORY_NOT_FOUND", `Directory '${resolved}' does not exist`);
      }
      throw error;
    }
    if (!stat.isDirectory()) {
      throw new GatewayError(400, "DIRECTORY_INVALID", `Path '${resolved}' is not a directory`);
    }
    return resolved;
  }

  private createMessage(
    role: Message["role"],
    content: string,
    status: Message["status"],
  ): Message {
    return { id: randomUUID(), role, content, status, createdAt: now() };
  }

  private snapshot(session: Session): Session {
    return { ...session, messages: session.messages.map((message) => ({ ...message })) };
  }

  private normalizeEngineError(error: unknown): { code: string; message: string; details?: unknown } {
    if (error instanceof GatewayError) {
      return { code: error.code, message: error.message, details: error.details };
    }
    return {
      code: "ENGINE_PROCESS_ERROR",
      message: error instanceof Error ? error.message : "Unknown engine error",
    };
  }
}
