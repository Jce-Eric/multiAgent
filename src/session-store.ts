import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GatewayError } from "./errors.js";
import type { Message, Session, SessionStatus } from "./types.js";

export interface SessionRepository {
  add(session: Session): void;
  save(session: Session): void;
  get(id: string): Session;
  delete(id: string): Session;
  list(): Session[];
  health(): boolean;
  close(): void;
}

export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();

  add(session: Session): void {
    this.sessions.set(session.id, session);
  }

  save(session: Session): void {
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

  health(): boolean {
    return true;
  }

  close(): void {}
}

interface SessionRow {
  id: string;
  engine: string;
  directory: string;
  status: string;
  messages_json: string;
  created_at: string;
  updated_at: string;
}

export class SqliteSessionRepository implements SessionRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        directory TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'busy')),
        messages_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_engine_updated_idx
        ON sessions(engine, updated_at DESC);
    `);
    this.database.prepare("UPDATE sessions SET status = 'idle' WHERE status = 'busy'").run();
  }

  add(session: Session): void {
    try {
      this.database.prepare(`
        INSERT INTO sessions
          (id, engine, directory, status, messages_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(...this.values(session));
    } catch (error) {
      throw new GatewayError(
        500,
        "PERSISTENCE_ERROR",
        `Could not persist session '${session.id}': ${errorMessage(error)}`,
      );
    }
  }

  save(session: Session): void {
    try {
      this.database.prepare(`
        UPDATE sessions
        SET engine = ?, directory = ?, status = ?, messages_json = ?, created_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        session.engine,
        session.directory,
        session.status,
        JSON.stringify(session.messages),
        session.createdAt,
        session.updatedAt,
        session.id,
      );
    } catch (error) {
      throw new GatewayError(
        500,
        "PERSISTENCE_ERROR",
        `Could not update session '${session.id}': ${errorMessage(error)}`,
      );
    }
  }

  get(id: string): Session {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    if (!row) {
      throw new GatewayError(404, "SESSION_NOT_FOUND", `Session '${id}' was not found`);
    }
    return this.fromRow(row);
  }

  delete(id: string): Session {
    const session = this.get(id);
    this.database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return session;
  }

  list(): Session[] {
    const rows = this.database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as
      unknown as SessionRow[];
    return rows.map((row) => this.fromRow(row));
  }

  health(): boolean {
    try {
      this.database.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.database.close();
  }

  private values(session: Session): [string, string, string, SessionStatus, string, string, string] {
    return [
      session.id,
      session.engine,
      session.directory,
      session.status,
      JSON.stringify(session.messages),
      session.createdAt,
      session.updatedAt,
    ];
  }

  private fromRow(row: SessionRow): Session {
    let messages: Message[];
    try {
      messages = JSON.parse(row.messages_json) as Message[];
      if (!Array.isArray(messages)) throw new Error("messages are not an array");
    } catch (error) {
      throw new GatewayError(
        500,
        "PERSISTENCE_ERROR",
        `Session '${row.id}' contains invalid message data: ${errorMessage(error)}`,
      );
    }
    return {
      id: row.id,
      engine: row.engine,
      directory: row.directory,
      status: row.status === "busy" ? "busy" : "idle",
      messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function createSessionRepository(databasePath?: string): SessionRepository {
  return databasePath
    ? new SqliteSessionRepository(databasePath)
    : new MemorySessionRepository();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { MemorySessionRepository as SessionStore };
