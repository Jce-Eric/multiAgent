import { randomUUID } from "node:crypto";
import type { PermissionPolicy } from "./config.js";
import { EventBus } from "./event-bus.js";
import { AbortGenerationError, GatewayError, isAbortError } from "./errors.js";
import {
  MemoryInteractionRepository,
  type InteractionRepository,
} from "./interaction-store.js";
import { MemoryRunRepository, type RunRepository } from "./run-store.js";
import { MemorySessionRepository, type SessionRepository } from "./session-store.js";
import type {
  InteractionType,
  Interaction,
  Message,
  PermissionResponse,
  QuestionResponse,
  Run,
  RunError,
  RunStatus,
  Session,
} from "./types.js";
import { deferred, now, type Deferred } from "./utils.js";
import type { AgentEngine, PermissionInput, QuestionInput } from "./engines/types.js";
import {
  asEngineCatalog,
  type EngineCatalogLike,
  type EngineDescriptor,
} from "./engines/catalog.js";
import { WorkspaceResolver } from "./workspace.js";

type InteractionResponse = QuestionResponse | PermissionResponse;
type AbortReason = "user" | "timeout" | "shutdown";

interface PendingInteraction {
  record: Interaction;
  value: Deferred<InteractionResponse>;
}

interface ActiveRun {
  record: Run;
  engine: AgentEngine;
  controller: AbortController;
  interactions: Map<string, PendingInteraction>;
  finished: Deferred<void>;
  prompt: string;
  started: boolean;
  abortReason?: AbortReason;
  timeout?: NodeJS.Timeout;
}

export interface GatewayServiceOptions {
  allowedRoots?: string[];
  generationTimeoutMs?: number;
  idleSessionTimeoutMs?: number;
  maxConcurrentRuns?: number;
  maxMessagesPerSession?: number;
  maxSessions?: number;
  permissionPolicy?: PermissionPolicy;
  repository?: SessionRepository;
  runRepository?: RunRepository;
  interactionRepository?: InteractionRepository;
  workspaceResolver?: WorkspaceResolver;
}

export class GatewayService {
  readonly repository: SessionRepository;
  readonly runs: RunRepository;
  readonly interactions: InteractionRepository;
  readonly engine: AgentEngine;
  readonly engineCatalog: EngineCatalogLike;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly generationTimeoutMs: number;
  private readonly idleSessionTimeoutMs: number;
  private readonly maxConcurrentRuns: number;
  private readonly maxMessagesPerSession: number;
  private readonly maxSessions: number;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly workspaceResolver: WorkspaceResolver;
  private shuttingDown = false;

  constructor(
    engineOrCatalog: AgentEngine | EngineCatalogLike,
    readonly events = new EventBus(),
    defaultDirectory = process.cwd(),
    options: GatewayServiceOptions = {},
  ) {
    this.engineCatalog = asEngineCatalog(engineOrCatalog);
    this.engine = this.engineCatalog.get(this.engineCatalog.defaultEngineName);
    this.repository = options.repository ?? new MemorySessionRepository();
    this.runs = options.runRepository ?? new MemoryRunRepository();
    this.interactions = options.interactionRepository ?? new MemoryInteractionRepository();
    this.workspaceResolver = options.workspaceResolver ?? new WorkspaceResolver(
      defaultDirectory,
      options.allowedRoots ?? [],
    );
    this.generationTimeoutMs = options.generationTimeoutMs ?? 10 * 60_000;
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? 5 * 60_000;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 10;
    this.maxMessagesPerSession = options.maxMessagesPerSession ?? 200;
    this.maxSessions = options.maxSessions ?? 100;
    this.permissionPolicy = options.permissionPolicy ?? "client";

    for (const session of this.repository.list()) {
      if (session.status !== "idle") {
        session.status = "idle";
        session.updatedAt = now();
        this.repository.save(session);
      }
      this.scheduleIdleClose(session.id);
    }
  }

  async createSession(directory?: string, engineName = this.engine.name): Promise<Session> {
    this.ensureAvailable();
    if (this.repository.list().length >= this.maxSessions) {
      throw new GatewayError(429, "RESOURCE_LIMIT", `Session limit of ${this.maxSessions} reached`);
    }
    const engine = this.engineCatalog.get(engineName);
    const resolved = await this.workspaceResolver.resolve(directory);
    const timestamp = now();
    const session: Session = {
      id: randomUUID(),
      engine: engine.name,
      directory: resolved.directory,
      workspace: resolved.workspace,
      status: "idle",
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await engine.openSession?.({
      sessionId: session.id,
      directory: session.directory,
      messages: [],
    });
    try {
      this.repository.add(session);
    } catch (error) {
      await Promise.resolve(engine.closeSession?.(session.id)).catch(() => undefined);
      throw error;
    }
    this.events.publish("session.created", this.snapshot(session), { sessionId: session.id });
    this.scheduleIdleClose(session.id);
    return this.snapshot(session);
  }

  listSessions(): Session[] {
    return this.repository.list().map((session) => this.snapshot(session));
  }

  getSession(id: string): Session {
    return this.snapshot(this.repository.get(id));
  }

  getRun(id: string): Run {
    return this.snapshotRun(this.runs.get(id));
  }

  listRuns(sessionId: string): Run[] {
    this.repository.get(sessionId);
    return this.runs.listForSession(sessionId).map((run) => this.snapshotRun(run));
  }

  getInteraction(id: string): Interaction {
    return this.snapshotInteraction(this.interactions.get(id));
  }

  listInteractions(sessionId: string): Interaction[] {
    this.repository.get(sessionId);
    return this.interactions.listForSession(sessionId).map((interaction) =>
      this.snapshotInteraction(interaction),
    );
  }

  listRunInteractions(runId: string): Interaction[] {
    this.runs.get(runId);
    return this.interactions.listForRun(runId).map((interaction) =>
      this.snapshotInteraction(interaction),
    );
  }

  listEngines(): EngineDescriptor[] {
    return this.engineCatalog.descriptors();
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.repository.get(id);
    const run = this.activeRuns.get(id);
    if (run) {
      if (run.started) {
        this.setRunStatus(run.record, "canceling");
        this.abortRun(run, "user");
      } else {
        this.cancelQueuedRun(session, run, "user");
      }
      await run.finished.promise;
    }
    this.clearIdleTimer(id);
    await this.engineCatalog.find(session.engine)?.closeSession?.(id);
    this.repository.delete(id);
    this.events.publish("session.deleted", { id: session.id }, { sessionId: session.id });
  }

  sendMessage(sessionId: string, content: string): { runId: string } {
    this.ensureAvailable();
    const session = this.repository.get(sessionId);
    const engine = this.engineCatalog.get(session.engine);
    if (session.status === "busy") {
      throw new GatewayError(409, "SESSION_BUSY", `Session '${sessionId}' is already busy`);
    }
    if (session.messages.length + 2 > this.maxMessagesPerSession) {
      throw new GatewayError(
        429,
        "RESOURCE_LIMIT",
        `Session message limit of ${this.maxMessagesPerSession} reached`,
      );
    }

    this.clearIdleTimer(sessionId);
    const userMessage = this.createMessage("user", content, "completed");
    session.messages.push(userMessage);
    session.updatedAt = now();
    this.repository.save(session);
    const timestamp = now();
    const record: Run = {
      id: randomUUID(),
      sessionId,
      engine: engine.name,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.runs.add(record);
    const run: ActiveRun = {
      record,
      engine,
      controller: new AbortController(),
      interactions: new Map(),
      finished: deferred<void>(),
      prompt: content,
      started: false,
    };
    this.activeRuns.set(sessionId, run);
    this.setStatus(session, "busy", record.id);
    this.events.publish("message.user", userMessage, { sessionId, runId: record.id });
    this.events.publish("run.created", this.snapshotRun(record), { sessionId, runId: record.id });
    this.drainRunQueue();
    return { runId: record.id };
  }

  respondToInteraction(
    sessionId: string,
    requestId: string,
    response: InteractionResponse,
  ): void {
    this.repository.get(sessionId);
    const run = this.activeRuns.get(sessionId);
    const interaction = run?.interactions.get(requestId);
    if (!run || !interaction) {
      let stored: Interaction;
      try {
        stored = this.interactions.get(requestId);
      } catch {
        throw new GatewayError(
          404,
          "INTERACTION_NOT_FOUND",
          `Interaction '${requestId}' was not found`,
        );
      }
      if (stored.sessionId === sessionId && stored.status !== "pending") {
        throw new GatewayError(
          409,
          "INTERACTION_NOT_PENDING",
          `Interaction '${requestId}' is already ${stored.status}`,
        );
      }
      throw new GatewayError(
        404,
        "INTERACTION_NOT_FOUND",
        `Interaction '${requestId}' was not found`,
      );
    }
    this.validateInteractionResponse(interaction.record.type, response);
    run.interactions.delete(requestId);
    this.resolveInteraction(interaction.record, response, "client");
    interaction.value.resolve(response);
    this.events.publish(
      "interaction.resolved",
      {
        requestId,
        interactionType: interaction.record.type,
        status: "resolved",
        response,
        resolvedBy: "client",
      },
      { sessionId, runId: run.record.id },
    );
    if (run.interactions.size === 0 && !run.controller.signal.aborted) {
      this.setRunStatus(run.record, "running");
    }
  }

  stopSession(sessionId: string): { runId: string } {
    const session = this.repository.get(sessionId);
    const run = this.activeRuns.get(sessionId);
    if (!run || session.status !== "busy") {
      throw new GatewayError(409, "SESSION_IDLE", `Session '${sessionId}' is not generating`);
    }
    if (!run.started) {
      this.cancelQueuedRun(session, run, "user");
      return { runId: run.record.id };
    }
    this.setRunStatus(run.record, "canceling");
    this.abortRun(run, "user");
    return { runId: run.record.id };
  }

  isReady(): boolean {
    return !this.shuttingDown &&
      this.repository.health() &&
      this.runs.health() &&
      this.interactions.health() &&
      this.events.health();
  }

  stats(): { activeRuns: number; queuedRuns: number; sessions: number; shuttingDown: boolean } {
    return {
      activeRuns: this.runningRunCount(),
      queuedRuns: [...this.activeRuns.values()].filter((run) => !run.started).length,
      sessions: this.repository.list().length,
      shuttingDown: this.shuttingDown,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const run of [...this.activeRuns.values()]) {
      if (run.started) {
        this.setRunStatus(run.record, "canceling");
        this.abortRun(run, "shutdown");
      } else {
        const session = this.repository.get(run.record.sessionId);
        this.cancelQueuedRun(session, run, "shutdown");
      }
    }
    await Promise.allSettled([...this.activeRuns.values()].map((run) => run.finished.promise));
    await Promise.allSettled(
      this.repository.list().map((session) =>
        this.engineCatalog.find(session.engine)?.closeSession?.(session.id),
      ),
    );
    this.repository.close();
    this.runs.close();
    this.interactions.close();
    this.events.close();
  }

  private async executeRun(session: Session, run: ActiveRun): Promise<void> {
    let accumulated = "";
    try {
      const result = await run.engine.generate(run.prompt, {
        sessionId: session.id,
        runId: run.record.id,
        directory: session.directory,
        messages: session.messages,
        signal: run.controller.signal,
        emitDelta: (text) => {
          if (!text || run.controller.signal.aborted) return;
          accumulated += text;
          this.events.publish("message.assistant.delta", { delta: text }, {
            sessionId: session.id,
            runId: run.record.id,
          });
        },
        askQuestion: (input) => this.createQuestion(session, run, input),
        requestPermission: (input) => this.createPermission(session, run, input),
        emitEvent: (type, data) => {
          if (run.controller.signal.aborted) return;
          this.events.publish("agent.event", { type, data }, {
            sessionId: session.id,
            runId: run.record.id,
          });
        },
      });
      if (run.controller.signal.aborted) throw new AbortGenerationError();
      if (!accumulated && result) {
        accumulated = result;
        this.events.publish("message.assistant.delta", { delta: result }, {
          sessionId: session.id,
          runId: run.record.id,
        });
      }
      const message = this.createMessage("assistant", accumulated, "completed");
      session.messages.push(message);
      session.updatedAt = now();
      this.repository.save(session);
      this.events.publish("message.assistant.completed", message, {
        sessionId: session.id,
        runId: run.record.id,
      });
      run.record.outputMessageId = message.id;
      this.setRunStatus(run.record, "completed");
      this.events.publish("generation.completed", { messageId: message.id }, {
        sessionId: session.id,
        runId: run.record.id,
      });
    } catch (error) {
      if (run.abortReason === "timeout") {
        const normalized = {
          code: "GENERATION_TIMEOUT",
          message: `Generation exceeded ${this.generationTimeoutMs}ms`,
          partialContent: accumulated,
        };
        if (accumulated) {
          const message = this.createMessage("assistant", accumulated, "stopped");
          session.messages.push(message);
          session.updatedAt = now();
          this.repository.save(session);
          this.events.publish("message.assistant.completed", message, {
            sessionId: session.id,
            runId: run.record.id,
          });
          run.record.outputMessageId = message.id;
        }
        this.setRunStatus(run.record, "failed", { error: normalized });
        this.events.publish("error", normalized, { sessionId: session.id, runId: run.record.id });
        this.events.publish("generation.failed", normalized, {
          sessionId: session.id,
          runId: run.record.id,
        });
      } else if (isAbortError(error) || run.controller.signal.aborted) {
        if (accumulated) {
          const message = this.createMessage("assistant", accumulated, "stopped");
          session.messages.push(message);
          session.updatedAt = now();
          this.repository.save(session);
          this.events.publish("message.assistant.completed", message, {
            sessionId: session.id,
            runId: run.record.id,
          });
          run.record.outputMessageId = message.id;
        }
        this.setRunStatus(run.record, "canceled", {
          stopReason: run.abortReason ?? "user",
        });
        this.events.publish(
          "generation.stopped",
          { partialContent: accumulated, reason: run.abortReason ?? "user" },
          { sessionId: session.id, runId: run.record.id },
        );
      } else {
        const normalized = this.normalizeEngineError(error);
        if (accumulated) {
          const message = this.createMessage("assistant", accumulated, "stopped");
          session.messages.push(message);
          session.updatedAt = now();
          this.repository.save(session);
          this.events.publish("message.assistant.completed", message, {
            sessionId: session.id,
            runId: run.record.id,
          });
          run.record.outputMessageId = message.id;
        }
        this.setRunStatus(run.record, "failed", { error: normalized });
        this.events.publish("error", normalized, { sessionId: session.id, runId: run.record.id });
        this.events.publish("generation.failed", normalized, {
          sessionId: session.id,
          runId: run.record.id,
        });
      }
    } finally {
      if (run.timeout) clearTimeout(run.timeout);
      for (const interaction of run.interactions.values()) {
        this.cancelInteraction(interaction.record, run.abortReason ?? "run_ended");
        interaction.value.reject(new AbortGenerationError());
      }
      run.interactions.clear();
      if (this.activeRuns.get(session.id)?.record.id === run.record.id) {
        this.activeRuns.delete(session.id);
      }
      this.setStatus(session, "idle", run.record.id);
      this.scheduleIdleClose(session.id);
      run.finished.resolve();
      this.drainRunQueue();
    }
  }

  private async createQuestion(
    session: Session,
    run: ActiveRun,
    input: QuestionInput,
  ): Promise<QuestionResponse> {
    const data = {
      question: input.question,
      choices: input.choices,
      schema: input.schema,
      metadata: input.metadata,
    };
    const interaction = this.registerInteraction(session, run, "question", data);
    this.setRunStatus(run.record, "input_required");
    this.events.publish(
      "interaction.question",
      {
        requestId: interaction.record.id,
        ...data,
      },
      { sessionId: session.id, runId: run.record.id },
    );
    return interaction.value.promise as Promise<QuestionResponse>;
  }

  private async createPermission(
    session: Session,
    run: ActiveRun,
    input: PermissionInput,
  ): Promise<PermissionResponse> {
    const data = {
      operation: input.operation,
      reason: input.reason,
      options: input.options,
      metadata: input.metadata,
    };
    const interaction = this.registerInteraction(session, run, "permission", data);
    this.setRunStatus(run.record, "input_required");
    this.events.publish(
      "interaction.permission",
      {
        requestId: interaction.record.id,
        ...data,
      },
      { sessionId: session.id, runId: run.record.id },
    );
    if (this.permissionPolicy !== "client") {
      const response: PermissionResponse = { decision: this.permissionPolicy };
      run.interactions.delete(interaction.record.id);
      this.resolveInteraction(interaction.record, response, "policy");
      interaction.value.resolve(response);
      this.events.publish(
        "interaction.resolved",
        {
          requestId: interaction.record.id,
          interactionType: "permission",
          status: "resolved",
          response,
          resolvedBy: "policy",
        },
        { sessionId: session.id, runId: run.record.id },
      );
      this.setRunStatus(run.record, "running");
    }
    return interaction.value.promise as Promise<PermissionResponse>;
  }

  private registerInteraction(
    session: Session,
    run: ActiveRun,
    type: InteractionType,
    data: unknown,
  ): PendingInteraction {
    if (run.controller.signal.aborted) throw new AbortGenerationError();
    const timestamp = now();
    const record: Interaction = {
      id: randomUUID(),
      sessionId: session.id,
      runId: run.record.id,
      type,
      status: "pending",
      data,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const interaction: PendingInteraction = {
      record,
      value: deferred<InteractionResponse>(),
    };
    this.interactions.add(record);
    run.interactions.set(record.id, interaction);
    return interaction;
  }

  private validateInteractionResponse(type: InteractionType, response: InteractionResponse): void {
    if (type === "question") {
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
      return;
    }
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

  private abortRun(run: ActiveRun, reason: AbortReason): void {
    if (run.controller.signal.aborted) return;
    run.abortReason = reason;
    run.controller.abort();
    for (const interaction of run.interactions.values()) {
      this.cancelInteraction(interaction.record, reason);
      interaction.value.reject(new AbortGenerationError());
    }
    run.interactions.clear();
  }

  private setStatus(session: Session, status: Session["status"], runId?: string): void {
    if (session.status === status) return;
    const previous = session.status;
    session.status = status;
    session.updatedAt = now();
    this.repository.save(session);
    this.events.publish("session.status.changed", { previous, status }, {
      sessionId: session.id,
      runId,
    });
  }

  private drainRunQueue(): void {
    if (this.shuttingDown) return;
    for (const run of this.activeRuns.values()) {
      if (this.runningRunCount() >= this.maxConcurrentRuns) return;
      if (run.started || run.record.status !== "queued") continue;
      const session = this.repository.get(run.record.sessionId);
      run.started = true;
      if (this.generationTimeoutMs > 0) {
        run.timeout = setTimeout(() => this.abortRun(run, "timeout"), this.generationTimeoutMs);
        run.timeout.unref();
      }
      this.setRunStatus(run.record, "running");
      this.events.publish(
        "generation.started",
        { engine: run.engine.name, directory: session.directory },
        { sessionId: session.id, runId: run.record.id },
      );
      void this.executeRun(session, run);
    }
  }

  private cancelQueuedRun(session: Session, run: ActiveRun, reason: AbortReason): void {
    if (run.started || run.record.status !== "queued") return;
    run.abortReason = reason;
    this.setRunStatus(run.record, "canceling");
    run.controller.abort();
    this.setRunStatus(run.record, "canceled", { stopReason: reason });
    this.events.publish(
      "generation.stopped",
      { partialContent: "", reason },
      { sessionId: session.id, runId: run.record.id },
    );
    this.activeRuns.delete(session.id);
    this.setStatus(session, "idle", run.record.id);
    this.scheduleIdleClose(session.id);
    run.finished.resolve();
    this.drainRunQueue();
  }

  private runningRunCount(): number {
    return [...this.activeRuns.values()].filter((run) => run.started).length;
  }

  private resolveInteraction(
    interaction: Interaction,
    response: InteractionResponse,
    resolvedBy: "client" | "policy",
  ): void {
    const timestamp = now();
    interaction.status = "resolved";
    interaction.response = response;
    interaction.resolvedBy = resolvedBy;
    interaction.updatedAt = timestamp;
    interaction.resolvedAt = timestamp;
    this.interactions.save(interaction);
  }

  private cancelInteraction(interaction: Interaction, reason: string): void {
    if (interaction.status !== "pending") return;
    const timestamp = now();
    interaction.status = "canceled";
    interaction.cancelReason = reason;
    interaction.updatedAt = timestamp;
    interaction.resolvedAt = timestamp;
    this.interactions.save(interaction);
    this.events.publish(
      "interaction.resolved",
      {
        requestId: interaction.id,
        interactionType: interaction.type,
        status: "canceled",
        cancelReason: reason,
      },
      { sessionId: interaction.sessionId, runId: interaction.runId },
    );
  }

  private setRunStatus(
    run: Run,
    status: RunStatus,
    update: { error?: RunError; stopReason?: string } = {},
  ): void {
    if (run.status === status && update.error === undefined && update.stopReason === undefined) return;
    const previous = run.status;
    run.status = status;
    run.updatedAt = now();
    if (update.error !== undefined) run.error = update.error;
    if (update.stopReason !== undefined) run.stopReason = update.stopReason;
    if (status === "completed" || status === "failed" || status === "canceled") {
      run.completedAt = run.updatedAt;
    }
    this.runs.save(run);
    this.events.publish(
      "run.status.changed",
      { previous, status, run: this.snapshotRun(run) },
      { sessionId: run.sessionId, runId: run.id },
    );
  }

  private scheduleIdleClose(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    if (this.idleSessionTimeoutMs <= 0 || this.shuttingDown) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      if (this.activeRuns.has(sessionId)) return;
      let session: Session;
      try {
        session = this.repository.get(sessionId);
      } catch {
        return;
      }
      void Promise.resolve(this.engineCatalog.find(session.engine)?.closeSession?.(sessionId)).then(() => {
        this.events.publish(
          "agent.event",
          { type: "gateway.runtime.closed", data: { reason: "idle_timeout" } },
          { sessionId },
        );
      }).catch(() => undefined);
    }, this.idleSessionTimeoutMs);
    timer.unref();
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(sessionId);
  }

  private ensureAvailable(): void {
    if (this.shuttingDown) {
      throw new GatewayError(503, "SERVICE_UNAVAILABLE", "Gateway is shutting down");
    }
  }

  private createMessage(
    role: Message["role"],
    content: string,
    status: Message["status"],
  ): Message {
    return {
      id: randomUUID(),
      role,
      content,
      parts: [{ type: "text", text: content }],
      status,
      createdAt: now(),
    };
  }

  private snapshot(session: Session): Session {
    return {
      ...session,
      workspace: session.workspace ?? { type: "local", directory: session.directory },
      messages: session.messages.map((message) => ({
        ...message,
        parts: message.parts
          ? message.parts.map((part) => ({ ...part }))
          : [{ type: "text", text: message.content }],
      })),
    };
  }

  private snapshotRun(run: Run): Run {
    return {
      ...run,
      ...(run.error ? { error: { ...run.error } } : {}),
    };
  }

  private snapshotInteraction(interaction: Interaction): Interaction {
    return {
      ...interaction,
      data: structuredClone(interaction.data),
      ...(interaction.response ? { response: structuredClone(interaction.response) } : {}),
    };
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
