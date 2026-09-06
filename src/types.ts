export type SessionStatus = "idle" | "busy";

export type MessageRole = "user" | "assistant";

export type MessageStatus = "completed" | "stopped";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown }
  | { type: "file"; name: string; path?: string; mimeType?: string }
  | { type: "artifact"; artifactId: string };

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  parts?: ContentPart[];
  status: MessageStatus;
  createdAt: string;
}

export interface WorkspaceRef {
  type: "local";
  directory: string;
}

export interface Session {
  id: string;
  engine: string;
  directory: string;
  workspace?: WorkspaceRef;
  status: SessionStatus;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "input_required"
  | "canceling"
  | "completed"
  | "failed"
  | "canceled";

export interface RunError {
  code: string;
  message: string;
  details?: unknown;
}

export interface Run {
  id: string;
  sessionId: string;
  engine: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  outputMessageId?: string;
  stopReason?: string;
  error?: RunError;
}

export type GatewayEventType =
  | "session.created"
  | "session.deleted"
  | "session.status.changed"
  | "run.created"
  | "run.status.changed"
  | "message.user"
  | "message.assistant.delta"
  | "message.assistant.completed"
  | "interaction.question"
  | "interaction.permission"
  | "interaction.resolved"
  | "agent.event"
  | "generation.started"
  | "generation.completed"
  | "generation.stopped"
  | "generation.failed"
  | "error";

export interface GatewayEvent<T = unknown> {
  id: number;
  specVersion: "1.0";
  source: "multi-agent-gateway";
  type: GatewayEventType;
  timestamp: string;
  sessionId?: string;
  runId?: string;
  data: T;
}

export type InteractionType = "question" | "permission";

export type InteractionStatus = "pending" | "resolved" | "canceled";

export interface QuestionResponse {
  answer?: string;
  answers?: Record<string, string | number | boolean | string[]>;
}

export interface PermissionResponse {
  decision?: "allow" | "deny";
  optionId?: string;
}

export interface Interaction {
  id: string;
  sessionId: string;
  runId: string;
  type: InteractionType;
  status: InteractionStatus;
  data: unknown;
  response?: QuestionResponse | PermissionResponse;
  resolvedBy?: "client" | "policy";
  cancelReason?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}
