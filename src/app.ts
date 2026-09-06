import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { createEngine, availableEngines } from "./engines/registry.js";
import { GatewayError } from "./errors.js";
import { GatewayService } from "./gateway-service.js";
import type { GatewayEvent, PermissionResponse, QuestionResponse } from "./types.js";

export interface AppOptions {
  engine?: string;
  env?: NodeJS.ProcessEnv;
  defaultDirectory?: string;
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
  const engineName = options.engine ?? env.AGENT_ENGINE ?? "codeagent";
  const service = new GatewayService(
    createEngine(engineName, env),
    undefined,
    options.defaultDirectory,
  );
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", engine: service.engine.name });
  });

  app.get("/v1/engines", (_request, response) => {
    response.json({
      active: service.engine.name,
      capabilities: service.engine.capabilities,
      available: availableEngines(env),
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

    for (const event of service.events.eventsAfter(lastEventId, sessionId)) {
      writeSse(response, event);
    }

    const unsubscribe = service.events.subscribe((event) => {
      if (!sessionId || event.sessionId === sessionId) {
        writeSse(response, event);
      }
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
      if (directory !== undefined && typeof directory !== "string") {
        throw new GatewayError(400, "VALIDATION_ERROR", "'directory' must be a string");
      }
      const session = await service.createSession(directory);
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
    response.status(202).json(
      service.stopSession(routeParam(request.params.sessionId, "sessionId")),
    );
  });

  app.use((_request, _response, next) => {
    next(new GatewayError(404, "VALIDATION_ERROR", "Route not found"));
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const requestId = randomUUID();
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

    console.error(error);
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId },
    });
  };
  app.use(errorHandler);

  return { app, service };
}
