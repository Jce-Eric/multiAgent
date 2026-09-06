import type { Message, PermissionResponse, QuestionResponse } from "../types.js";

export interface QuestionInput {
  question: string;
  choices?: string[];
  schema?: unknown;
  metadata?: unknown;
}

export interface PermissionInput {
  operation: string;
  reason?: string;
  options?: Array<{
    optionId: string;
    name: string;
    kind?: string;
  }>;
  metadata?: unknown;
}

export interface AgentCapabilities {
  protocol: string;
  protocolVersion: string;
  nativeSessions: boolean;
  questions: boolean;
  permissions: boolean;
  cancellation: boolean;
}

export interface AgentSessionContext {
  sessionId: string;
  directory: string;
  messages: readonly Message[];
}

export interface AgentRunContext {
  sessionId: string;
  runId: string;
  directory: string;
  messages: readonly Message[];
  signal: AbortSignal;
  emitDelta: (text: string) => void;
  askQuestion: (input: QuestionInput) => Promise<QuestionResponse>;
  requestPermission: (input: PermissionInput) => Promise<PermissionResponse>;
  emitEvent: (type: string, data: unknown) => void;
}

export interface AgentEngine {
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  openSession?(context: AgentSessionContext): Promise<void>;
  closeSession?(sessionId: string): Promise<void>;
  generate(prompt: string, context: AgentRunContext): Promise<string>;
}
