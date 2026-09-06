export type ErrorCode =
  | "VALIDATION_ERROR"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "SESSION_IDLE"
  | "RUN_NOT_FOUND"
  | "INTERACTION_NOT_FOUND"
  | "INTERACTION_NOT_PENDING"
  | "INTERACTION_RESPONSE_INVALID"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_INVALID"
  | "DIRECTORY_NOT_ALLOWED"
  | "ENGINE_NOT_FOUND"
  | "ENGINE_PROTOCOL_ERROR"
  | "ENGINE_PROCESS_ERROR"
  | "ENGINE_CONFIG_INVALID"
  | "ENGINE_SESSION_ERROR"
  | "GENERATION_TIMEOUT"
  | "RESOURCE_LIMIT"
  | "PERSISTENCE_ERROR"
  | "UNAUTHORIZED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export class AbortGenerationError extends Error {
  constructor(message = "Generation was stopped") {
    super(message);
    this.name = "AbortGenerationError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AbortGenerationError ||
    (error instanceof Error && error.name === "AbortError")
  );
}
