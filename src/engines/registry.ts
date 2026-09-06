import { GatewayError } from "../errors.js";
import type { AgentEngine } from "./types.js";
import { ProcessBridgeEngine } from "./process-bridge-engine.js";
import { ReferenceEngine } from "./reference-engine.js";

const ENGINE_CONFIG = {
  codeagent: { env: "CODEAGENT_COMMAND", label: "CodeAgent" },
  opencode: { env: "OPENCODE_COMMAND", label: "OpenCode" },
  "deepseek-harness": { env: "DEEPSEEK_HARNESS_COMMAND", label: "DeepSeek Harness" },
} as const;

export type EngineName = keyof typeof ENGINE_CONFIG;

export function availableEngines(): EngineName[] {
  return Object.keys(ENGINE_CONFIG) as EngineName[];
}

export function createEngine(name: string, env: NodeJS.ProcessEnv = process.env): AgentEngine {
  const normalized = name.toLowerCase() as EngineName;
  const config = ENGINE_CONFIG[normalized];
  if (!config) {
    throw new GatewayError(400, "ENGINE_NOT_FOUND", `Unknown engine '${name}'`, {
      availableEngines: availableEngines(),
    });
  }

  const command = env[config.env]?.trim();
  return command
    ? new ProcessBridgeEngine(normalized, command)
    : new ReferenceEngine(normalized, config.label);
}
