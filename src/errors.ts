export type ErrorCode =
  | "VALIDATION_ERROR"
  | "SESSION_NOT_FOUND"
  | "SESSION_BUSY"
  | "SESSION_IDLE"
  | "INTERACTION_NOT_FOUND"
  | "INTERACTION_RESPONSE_INVALID"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_INVALID"
  | "ENGINE_NOT_FOUND"
  | "ENGINE_PROTOCOL_ERROR"
  | "ENGINE_PROCESS_ERROR"
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
