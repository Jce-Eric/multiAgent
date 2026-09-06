import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GatewayError } from "./errors.js";
import type { GatewayEvent, GatewayEventType } from "./types.js";

export type NewGatewayEvent = Omit<GatewayEvent, "id">;

export interface EventRepository {
  append(event: NewGatewayEvent): GatewayEvent;
  eventsAfter(lastEventId: number, sessionId?: string): GatewayEvent[];
  health(): boolean;
  close(): void;
}

export class MemoryEventRepository implements EventRepository {
  private sequence = 0;
  private readonly history: GatewayEvent[] = [];

  constructor(private readonly historyLimit = 1_000) {}

  append(event: NewGatewayEvent): GatewayEvent {
    const stored = { id: ++this.sequence, ...event };
    this.history.push(stored);
    if (this.history.length > this.historyLimit) this.history.shift();
    return stored;
  }

  eventsAfter(lastEventId: number, sessionId?: string): GatewayEvent[] {
    return this.history.filter(
      (event) => event.id > lastEventId && (!sessionId || event.sessionId === sessionId),
    );
  }

  health(): boolean {
    return true;
  }

  close(): void {}
}

interface EventRow {
  id: number;
  spec_version: string;
  source: string;
  type: string;
  timestamp: string;
  session_id: string | null;
  run_id: string | null;
  data_json: string;
}

export class SqliteEventRepository implements EventRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly historyLimit = 1_000) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_version TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gateway_events_session_id_idx
        ON gateway_events(session_id, id);
    `);
  }

  append(event: NewGatewayEvent): GatewayEvent {
    try {
      const result = this.database.prepare(`
        INSERT INTO gateway_events
          (spec_version, source, type, timestamp, session_id, run_id, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.specVersion,
        event.source,
        event.type,
        event.timestamp,
        event.sessionId ?? null,
        event.runId ?? null,
        JSON.stringify(event.data),
      );
      this.database.prepare(`
        DELETE FROM gateway_events
        WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM gateway_events)
      `).run(this.historyLimit);
      return { id: Number(result.lastInsertRowid), ...event };
    } catch (error) {
      throw persistenceError("Could not persist gateway event", error);
    }
  }

  eventsAfter(lastEventId: number, sessionId?: string): GatewayEvent[] {
    const rows = (sessionId
      ? this.database.prepare(
          "SELECT * FROM gateway_events WHERE id > ? AND session_id = ? ORDER BY id",
        ).all(lastEventId, sessionId)
      : this.database.prepare(
          "SELECT * FROM gateway_events WHERE id > ? ORDER BY id",
        ).all(lastEventId)) as unknown as EventRow[];
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

  private fromRow(row: EventRow): GatewayEvent {
    try {
      return {
        id: row.id,
        specVersion: row.spec_version as "1.0",
        source: row.source as "multi-agent-gateway",
        type: row.type as GatewayEventType,
        timestamp: row.timestamp,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        ...(row.run_id ? { runId: row.run_id } : {}),
        data: JSON.parse(row.data_json) as unknown,
      };
    } catch (error) {
      throw persistenceError(`Gateway event '${row.id}' contains invalid data`, error);
    }
  }
}

export function createEventRepository(
  databasePath: string | undefined,
  historyLimit: number,
): EventRepository {
  return databasePath
    ? new SqliteEventRepository(databasePath, historyLimit)
    : new MemoryEventRepository(historyLimit);
}

function persistenceError(message: string, error: unknown): GatewayError {
  return new GatewayError(
    500,
    "PERSISTENCE_ERROR",
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
