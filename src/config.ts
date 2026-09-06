import path from "node:path";
import { GatewayError } from "./errors.js";

export type PermissionPolicy = "client" | "allow" | "deny";

export interface GatewayConfig {
  apiKey?: string;
  allowedRoots: string[];
  databasePath?: string;
  eventHistoryLimit: number;
  generationTimeoutMs: number;
  idleSessionTimeoutMs: number;
  logLevel: "info" | "silent";
  maxConcurrentRuns: number;
  maxMessagesPerSession: number;
  maxSessions: number;
  permissionPolicy: PermissionPolicy;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const permissionPolicy = env.PERMISSION_POLICY?.trim().toLowerCase() ?? "client";
  if (permissionPolicy !== "client" && permissionPolicy !== "allow" && permissionPolicy !== "deny") {
    throw new GatewayError(
      400,
      "ENGINE_CONFIG_INVALID",
      "PERMISSION_POLICY must be 'client', 'allow', or 'deny'",
    );
  }

  const logLevel = env.LOG_LEVEL?.trim().toLowerCase() ?? "info";
  if (logLevel !== "info" && logLevel !== "silent") {
    throw new GatewayError(400, "ENGINE_CONFIG_INVALID", "LOG_LEVEL must be 'info' or 'silent'");
  }

  const rawRoots = env.AGENT_ALLOWED_ROOTS?.trim();
  return {
    apiKey: env.GATEWAY_API_KEY?.trim() || undefined,
    allowedRoots: rawRoots
      ? rawRoots.split(path.delimiter).map((root) => root.trim()).filter(Boolean)
      : [],
    databasePath:
      env.GATEWAY_DATABASE_PATH?.trim() || env.SESSION_DATABASE_PATH?.trim() || undefined,
    eventHistoryLimit: integerEnv(env, "EVENT_HISTORY_LIMIT", 1_000, 1),
    generationTimeoutMs: integerEnv(env, "GENERATION_TIMEOUT_MS", 10 * 60_000, 0),
    idleSessionTimeoutMs: integerEnv(env, "IDLE_SESSION_TIMEOUT_MS", 5 * 60_000, 0),
    logLevel,
    maxConcurrentRuns: integerEnv(env, "MAX_CONCURRENT_RUNS", 10, 1),
    maxMessagesPerSession: integerEnv(env, "MAX_MESSAGES_PER_SESSION", 200, 2),
    maxSessions: integerEnv(env, "MAX_SESSIONS", 100, 1),
    permissionPolicy,
  };
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new GatewayError(
      400,
      "ENGINE_CONFIG_INVALID",
      `${name} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}
