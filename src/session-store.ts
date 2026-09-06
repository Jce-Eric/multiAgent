import type { Session } from "./types.js";
import { GatewayError } from "./errors.js";

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  add(session: Session): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new GatewayError(404, "SESSION_NOT_FOUND", `Session '${id}' was not found`);
    }
    return session;
  }

  delete(id: string): Session {
    const session = this.get(id);
    this.sessions.delete(id);
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }
}
