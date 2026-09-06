import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import { EngineCatalog } from "./engines/catalog.js";
import { GatewayError } from "./errors.js";
import { EventBus } from "./event-bus.js";
import { createEventRepository, type EventRepository } from "./event-store.js";
import { GatewayService } from "./gateway-service.js";
import { GatewayMetrics } from "./metrics.js";
import { createRunRepository, type RunRepository } from "./run-store.js";
import { createSessionRepository, type SessionRepository } from "./session-store.js";
import type { GatewayEvent, PermissionResponse, QuestionResponse } from "./types.js";
import { GATEWAY_VERSION } from "./version.js";

export interface AppOptions {
  engine?: string;
  env?: NodeJS.ProcessEnv;
  defaultDirectory?: string;
  config?: Partial<GatewayConfig>;
  repository?: SessionRepository;
  runRepository?: RunRepository;
  eventRepository?: EventRepository;
}

const asyncRoute =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError(400, "VALIDATION_ERROR", `'${field}' must be a non-empty string`);
  }
  return value;
}

function routeParam(value: string | string[], field: string): string {
  return requiredString(Array.isArray(value) ? value[0] : value, field);
}

function writeSse(response: Response, event: GatewayEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createApp(options: AppOptions = {}) {
  const env = options.env ?? process.env;
  const config = { ...loadGatewayConfig(env), ...options.config };
  const engineName = options.engine ?? env.AGENT_ENGINE ?? "codeagent";
  const engineCatalog = new EngineCatalog(engineName, env);
  const eventRepository = options.eventRepository ?? createEventRepository(
    config.databasePath,
    config.eventHistoryLimit,
  );
  const events = new EventBus(config.eventHistoryLimit, eventRepository);
  const repository = options.repository ?? createSessionRepository(config.databasePath);
  const runRepository = options.runRepository ?? createRunRepository(config.databasePath);
  const service = new GatewayService(
    engineCatalog,
    events,
    options.defaultDirectory,
    {
      allowedRoots: config.allowedRoots,
      generationTimeoutMs: config.generationTimeoutMs,
      idleSessionTimeoutMs: config.idleSessionTimeoutMs,
      maxConcurrentRuns: config.maxConcurrentRuns,
      maxMessagesPerSession: config.maxMessagesPerSession,
      maxSessions: config.maxSessions,
      permissionPolicy: config.permissionPolicy,
      repository,
      runRepository,
    },
  );
  const metrics = new GatewayMetrics(service);
  const app = express();

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const requestId = request.get("x-request-id")?.trim() || randomUUID();
    const startedAt = Date.now();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      const route = request.route?.path
        ? `${request.baseUrl}${String(request.route.path)}`
        : request.path;
      metrics.observeRequest(request.method, route, response.statusCode);
      if (config.logLevel === "info") {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "http_request",
          requestId,
          method: request.method,
          path: request.originalUrl,
          route,
          status: response.statusCode,
          durationMs: Date.now() - startedAt,
          sessionId: sessionIdFromPath(request.path),
          runId: response.locals.runId,
        }));
      }
    });
    next();
  });
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", engine: service.engine.name, version: GATEWAY_VERSION });
  });

  app.get("/ready", (_request, response) => {
    const ready = service.isReady();
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });

  app.get("/openapi.yaml", (_request, response) => {
    response.sendFile(path.resolve(process.cwd(), "openapi.yaml"));
  });

  app.get("/asyncapi.yaml", (_request, response) => {
    response.sendFile(path.resolve(process.cwd(), "asyncapi.yaml"));
  });

  app.use((request, _response, next) => {
    if (!config.apiKey || !(request.path.startsWith("/v1") || request.path === "/metrics")) {
      next();
      return;
    }
    const authorization = request.get("authorization");
    const provided = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : request.get("x-api-key");
    if (!provided || !secureEqual(provided, config.apiKey)) {
      next(new GatewayError(401, "UNAUTHORIZED", "A valid gateway API key is required"));
      return;
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.get("/metrics", (_request, response) => {
    response.type("text/plain; version=0.0.4").send(metrics.render());
  });

  app.get("/v1/engines", (_request, response) => {
    const engines = service.listEngines();
    response.json({
      gatewayVersion: GATEWAY_VERSION,
      active: service.engine.name,
      capabilities: service.engine.capabilities,
      available: engines.map((engine) => engine.name),
      engines,
    });
  });

  app.get("/v1/events", (request, response) => {
    const sessionId = typeof request.query.sessionId === "string" ? request.query.sessionId : undefined;
    const rawLastId = request.get("last-event-id") ?? request.query.lastEventId ?? "0";
    const lastEventId = Number(rawLastId);
    if (!Number.isFinite(lastEventId) || lastEventId < 0) {
      throw new GatewayError(400, "VALIDATION_ERROR", "Last-Event-ID must be a positive number");
    }
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write(": connected\n\n");
    for (const event of service.events.eventsAfter(lastEventId, sessionId)) writeSse(response, event);
    const unsubscribe = service.events.subscribe((event) => {
      if (!sessionId || event.sessionId === sessionId) writeSse(response, event);
    });
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/v1/sessions", (_request, response) => {
    response.json({ sessions: service.listSessions() });
  });

  app.post(
    "/v1/sessions",
    asyncRoute(async (request, response) => {
      const directory = request.body?.directory;
      const engine = request.body?.engine;
      if (directory !== undefined && typeof directory !== "string") {
        throw new GatewayError(400, "VALIDATION_ERROR", "'directory' must be a string");
      }
      if (engine !== undefined && typeof engine !== "string") {
        throw new GatewayError(400, "VALIDATION_ERROR", "'engine' must be a string");
      }
      const session = await service.createSession(directory, engine);
      response.status(201).json({ session });
    }),
  );

  app.get("/v1/sessions/:sessionId", (request, response) => {
    response.json({ session: service.getSession(routeParam(request.params.sessionId, "sessionId")) });
  });

  app.delete(
    "/v1/sessions/:sessionId",
    asyncRoute(async (request, response) => {
      await service.deleteSession(routeParam(request.params.sessionId, "sessionId"));
      response.status(204).end();
    }),
  );

  app.post("/v1/sessions/:sessionId/messages", (request, response) => {
    const content = requiredString(request.body?.content, "content");
    const result = service.sendMessage(routeParam(request.params.sessionId, "sessionId"), content);
    response.locals.runId = result.runId;
    response.status(202).json(result);
  });

  app.post("/v1/sessions/:sessionId/interactions/:requestId/respond", (request, response) => {
    const payload = request.body as QuestionResponse | PermissionResponse;
    if (!payload || typeof payload !== "object") {
      throw new GatewayError(400, "VALIDATION_ERROR", "A response body is required");
    }
    service.respondToInteraction(
      routeParam(request.params.sessionId, "sessionId"),
      routeParam(request.params.requestId, "requestId"),
      payload,
    );
    response.status(202).json({ accepted: true });
  });

  app.post("/v1/sessions/:sessionId/stop", (request, response) => {
    const result = service.stopSession(routeParam(request.params.sessionId, "sessionId"));
    response.locals.runId = result.runId;
    response.status(202).json(result);
  });

  app.get("/v1/sessions/:sessionId/runs", (request, response) => {
    const sessionId = routeParam(request.params.sessionId, "sessionId");
    response.json({ runs: service.listRuns(sessionId) });
  });

  app.get("/v1/runs/:runId", (request, response) => {
    response.json({ run: service.getRun(routeParam(request.params.runId, "runId")) });
  });

  app.use((_request, _response, next) => {
    next(new GatewayError(404, "VALIDATION_ERROR", "Route not found"));
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const requestId = String(response.locals.requestId ?? randomUUID());
    if (error instanceof GatewayError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          requestId,
        },
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON", requestId },
      });
      return;
    }
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "unhandled_request_error",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }));
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId },
    });
  };
  app.use(errorHandler);

  return { app, service, config, metrics };
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionIdFromPath(pathname: string): string | undefined {
  return pathname.match(/^\/v1\/sessions\/([^/]+)/)?.[1];
}
