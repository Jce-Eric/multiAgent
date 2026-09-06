import type { Message, PermissionResponse, QuestionResponse } from "../types.js";

export interface QuestionInput {
  question: string;
  choices?: string[];
}

export interface PermissionInput {
  operation: string;
  reason?: string;
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
}

export interface AgentEngine {
  readonly name: string;
  generate(prompt: string, context: AgentRunContext): Promise<string>;
}
