import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { GatewayError } from "../errors.js";
import { AcpEngine } from "./acp-engine.js";
import { CodexAppServerEngine } from "./codex-app-server-engine.js";
import type { AgentEngine } from "./types.js";
import { ProcessBridgeEngine } from "./process-bridge-engine.js";
import { ReferenceEngine } from "./reference-engine.js";

export type EngineProtocol = "reference" | "jsonl" | "acp" | "codex";

export interface EngineDefinition {
  protocol: EngineProtocol;
  command?: string;
  displayName?: string;
}

interface EngineConfigFile {
  engines?: Record<string, EngineDefinition>;
}

const require = createRequire(import.meta.url);

const BUILTIN_ENGINES = {
  codeagent: {
    prefix: "CODEAGENT",
    label: "CodeAgent",
    protocol: "codex",
    command: packagedCommand(
      "@openai/codex",
      "bin/codex.js",
      ["app-server", "--stdio"],
      "codex app-server --stdio",
    ),
  },
  opencode: {
    prefix: "OPENCODE",
    label: "OpenCode",
    protocol: "acp",
    command: packagedNativeCommand(
      "opencode-ai",
      "bin/opencode.exe",
      ["acp"],
      "opencode acp",
    ),
  },
  "deepseek-harness": {
    prefix: "DEEPSEEK_HARNESS",
    label: "DeepSeek Harness",
    protocol: "acp",
    command: packagedCommand(
      "@deepseek-ai/dsh",
      "lib/bin.js",
      ["--profile", "acp"],
      "dsh --profile acp",
    ),
  },
} as const;

export type EngineName = string;

export function availableEngines(env: NodeJS.ProcessEnv = process.env): EngineName[] {
  return Object.keys(loadDefinitions(env));
}

export function createEngine(name: string, env: NodeJS.ProcessEnv = process.env): AgentEngine {
  const normalized = name.toLowerCase();
  const definitions = loadDefinitions(env);
  const definition = definitions[normalized];
  if (!definition) {
    throw new GatewayError(400, "ENGINE_NOT_FOUND", `Unknown engine '${name}'`, {
      availableEngines: Object.keys(definitions),
    });
  }

  if (definition.protocol === "reference") {
    return new ReferenceEngine(normalized, definition.displayName ?? normalized);
  }
  if (!definition.command?.trim()) {
    throw new GatewayError(
      400,
      "ENGINE_CONFIG_INVALID",
      `Engine '${normalized}' requires a command for protocol '${definition.protocol}'`,
    );
  }
  if (definition.protocol === "acp") {
    return new AcpEngine(normalized, definition.command, env);
  }
  if (definition.protocol === "codex") {
    return new CodexAppServerEngine(normalized, definition.command, env);
  }
  return new ProcessBridgeEngine(normalized, definition.command, env);
}

function loadDefinitions(env: NodeJS.ProcessEnv): Record<string, EngineDefinition> {
  const definitions: Record<string, EngineDefinition> = {};
  for (const [name, builtin] of Object.entries(BUILTIN_ENGINES)) {
    const configuredCommand = env[`${builtin.prefix}_COMMAND`]?.trim();
    const configuredProtocol = env[`${builtin.prefix}_PROTOCOL`];
    const protocol = normalizeProtocol(
      configuredProtocol ?? builtin.protocol,
      name,
    );
    definitions[name] = {
      protocol,
      command: configuredCommand ?? ("command" in builtin ? builtin.command : undefined),
      displayName: builtin.label,
    };
  }

  const configPath = env.AGENT_ENGINE_CONFIG?.trim();
  if (!configPath) return definitions;

  let parsed: EngineConfigFile;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(configPath), "utf8")) as EngineConfigFile;
  } catch (error) {
    throw new GatewayError(
      400,
      "ENGINE_CONFIG_INVALID",
      `Could not read engine config '${configPath}': ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!parsed.engines || typeof parsed.engines !== "object") {
    throw new GatewayError(400, "ENGINE_CONFIG_INVALID", "Engine config requires an 'engines' object");
  }

  for (const [rawName, rawDefinition] of Object.entries(parsed.engines)) {
    const name = rawName.toLowerCase();
    if (!rawDefinition || typeof rawDefinition !== "object") {
      throw new GatewayError(400, "ENGINE_CONFIG_INVALID", `Engine '${name}' has an invalid definition`);
    }
    if (rawDefinition.command !== undefined && typeof rawDefinition.command !== "string") {
      throw new GatewayError(400, "ENGINE_CONFIG_INVALID", `Engine '${name}' command must be a string`);
    }
    if (rawDefinition.displayName !== undefined && typeof rawDefinition.displayName !== "string") {
      throw new GatewayError(400, "ENGINE_CONFIG_INVALID", `Engine '${name}' displayName must be a string`);
    }
    definitions[name] = {
      protocol: normalizeProtocol(rawDefinition.protocol, name),
      command: rawDefinition.command,
      displayName: rawDefinition.displayName ?? rawName,
    };
  }
  return definitions;
}

function normalizeProtocol(value: unknown, engineName: string): EngineProtocol {
  if (value === "reference" || value === "jsonl" || value === "acp" || value === "codex") {
    return value;
  }
  throw new GatewayError(
    400,
    "ENGINE_CONFIG_INVALID",
    `Engine '${engineName}' has unsupported protocol '${String(value)}'`,
  );
}

function packagedCommand(
  packageName: string,
  relativeBinPath: string,
  args: string[],
  fallback: string,
): string {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const binPath = path.resolve(path.dirname(packagePath), relativeBinPath);
    return [process.execPath, binPath, ...args].map((value) => JSON.stringify(value)).join(" ");
  } catch {
    return fallback;
  }
}

function packagedNativeCommand(
  packageName: string,
  relativeBinPath: string,
  args: string[],
  fallback: string,
): string {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const binPath = path.resolve(path.dirname(packagePath), relativeBinPath);
    return [binPath, ...args].map((value) => JSON.stringify(value)).join(" ");
  } catch {
    return fallback;
  }
}
