export type SessionStatus = "idle" | "busy";

export type MessageRole = "user" | "assistant";

export type MessageStatus = "completed" | "stopped";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: string;
}

export interface Session {
  id: string;
  engine: string;
  directory: string;
  status: SessionStatus;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export type GatewayEventType =
  | "session.created"
  | "session.deleted"
  | "session.status.changed"
  | "message.user"
  | "message.assistant.delta"
  | "message.assistant.completed"
  | "interaction.question"
  | "interaction.permission"
  | "interaction.resolved"
  | "generation.started"
  | "generation.completed"
  | "generation.stopped"
  | "generation.failed"
  | "error";

export interface GatewayEvent<T = unknown> {
  id: number;
  type: GatewayEventType;
  timestamp: string;
  sessionId?: string;
  runId?: string;
  data: T;
}

export type InteractionType = "question" | "permission";

export interface QuestionResponse {
  answer: string;
}

export interface PermissionResponse {
  decision: "allow" | "deny";
}
