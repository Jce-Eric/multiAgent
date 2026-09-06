import { GatewayError } from "../errors.js";
import {
  createEngineFromDefinition,
  loadEngineDefinitions,
  type EngineDefinition,
} from "./registry.js";
import type { AgentCapabilities, AgentEngine } from "./types.js";

export interface EngineDescriptor {
  name: string;
  displayName: string;
  capabilities: AgentCapabilities;
}

export interface EngineCatalogLike {
  readonly defaultEngineName: string;
  get(name: string): AgentEngine;
  find(name: string): AgentEngine | undefined;
  names(): string[];
  descriptors(): EngineDescriptor[];
}

export class EngineCatalog implements EngineCatalogLike {
  private readonly definitions: Record<string, EngineDefinition>;
  private readonly instances = new Map<string, AgentEngine>();

  constructor(
    public readonly defaultEngineName: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.definitions = loadEngineDefinitions(env);
    this.get(defaultEngineName);
  }

  get(name: string): AgentEngine {
    const normalized = name.trim().toLowerCase();
    const definition = this.definitions[normalized];
    if (!definition) {
      throw new GatewayError(400, "ENGINE_NOT_FOUND", `Unknown engine '${name}'`, {
        availableEngines: this.names(),
      });
    }
    let engine = this.instances.get(normalized);
    if (!engine) {
      engine = createEngineFromDefinition(normalized, definition, this.env);
      this.instances.set(normalized, engine);
    }
    return engine;
  }

  find(name: string): AgentEngine | undefined {
    const normalized = name.trim().toLowerCase();
    return this.definitions[normalized] ? this.get(normalized) : undefined;
  }

  names(): string[] {
    return Object.keys(this.definitions);
  }

  descriptors(): EngineDescriptor[] {
    return this.names().map((name) => ({
      name,
      displayName: this.definitions[name].displayName ?? name,
      capabilities: this.get(name).capabilities,
    }));
  }
}

export class StaticEngineCatalog implements EngineCatalogLike {
  readonly defaultEngineName: string;

  constructor(private readonly engine: AgentEngine) {
    this.defaultEngineName = engine.name;
  }

  get(name: string): AgentEngine {
    if (name.toLowerCase() !== this.engine.name.toLowerCase()) {
      throw new GatewayError(400, "ENGINE_NOT_FOUND", `Unknown engine '${name}'`, {
        availableEngines: [this.engine.name],
      });
    }
    return this.engine;
  }

  find(name: string): AgentEngine | undefined {
    return name.toLowerCase() === this.engine.name.toLowerCase() ? this.engine : undefined;
  }

  names(): string[] {
    return [this.engine.name];
  }

  descriptors(): EngineDescriptor[] {
    return [{
      name: this.engine.name,
      displayName: this.engine.name,
      capabilities: this.engine.capabilities,
    }];
  }
}

export function asEngineCatalog(value: AgentEngine | EngineCatalogLike): EngineCatalogLike {
  return "defaultEngineName" in value ? value : new StaticEngineCatalog(value);
}
