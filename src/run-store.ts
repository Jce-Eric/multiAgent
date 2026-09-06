import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GatewayError } from "./errors.js";
import type { Run, RunError, RunStatus } from "./types.js";
import { now } from "./utils.js";

export interface RunRepository {
  add(run: Run): void;
  save(run: Run): void;
  get(id: string): Run;
  listForSession(sessionId: string): Run[];
  list(): Run[];
  health(): boolean;
  close(): void;
}

export class MemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, Run>();

  add(run: Run): void {
    this.runs.set(run.id, run);
  }

  save(run: Run): void {
    this.runs.set(run.id, run);
  }

  get(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw runNotFound(id);
    return run;
  }

  listForSession(sessionId: string): Run[] {
    return this.list().filter((run) => run.sessionId === sessionId);
  }

  list(): Run[] {
    return [...this.runs.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  health(): boolean {
    return true;
  }

  close(): void {}
}

interface RunRow {
  id: string;
  session_id: string;
  engine: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  output_message_id: string | null;
  stop_reason: string | null;
  error_json: string | null;
}

export class SqliteRunRepository implements RunRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.database = new DatabaseSync(resolved);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        output_message_id TEXT,
        stop_reason TEXT,
        error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_session_created_idx
        ON runs(session_id, created_at DESC);
    `);
    const timestamp = now();
    this.database.prepare(`
      UPDATE runs
      SET status = 'failed', updated_at = ?, completed_at = ?,
          error_json = ?
      WHERE status IN ('queued', 'running', 'input_required', 'canceling')
    `).run(
      timestamp,
      timestamp,
      JSON.stringify({
        code: "GATEWAY_RESTARTED",
        message: "Run was interrupted because the gateway restarted",
      }),
    );
  }

  add(run: Run): void {
    try {
      this.database.prepare(`
        INSERT INTO runs
          (id, session_id, engine, status, created_at, updated_at, completed_at,
           output_message_id, stop_reason, error_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...this.values(run));
    } catch (error) {
      throw persistenceError(`Could not persist run '${run.id}'`, error);
    }
  }

  save(run: Run): void {
    try {
      this.database.prepare(`
        UPDATE runs
        SET session_id = ?, engine = ?, status = ?, created_at = ?, updated_at = ?,
            completed_at = ?, output_message_id = ?, stop_reason = ?, error_json = ?
        WHERE id = ?
      `).run(
        run.sessionId,
        run.engine,
        run.status,
        run.createdAt,
        run.updatedAt,
        run.completedAt ?? null,
        run.outputMessageId ?? null,
        run.stopReason ?? null,
        run.error === undefined ? null : JSON.stringify(run.error),
        run.id,
      );
    } catch (error) {
      throw persistenceError(`Could not update run '${run.id}'`, error);
    }
  }

  get(id: string): Run {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    if (!row) throw runNotFound(id);
    return this.fromRow(row);
  }

  listForSession(sessionId: string): Run[] {
    const rows = this.database.prepare(
      "SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC",
    ).all(sessionId) as unknown as RunRow[];
    return rows.map((row) => this.fromRow(row));
  }

  list(): Run[] {
    const rows = this.database.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as
      unknown as RunRow[];
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

  private values(run: Run): [
    string,
    string,
    string,
    RunStatus,
    string,
    string,
    string | null,
    string | null,
    string | null,
    string | null,
  ] {
    return [
      run.id,
      run.sessionId,
      run.engine,
      run.status,
      run.createdAt,
      run.updatedAt,
      run.completedAt ?? null,
      run.outputMessageId ?? null,
      run.stopReason ?? null,
      run.error === undefined ? null : JSON.stringify(run.error),
    ];
  }

  private fromRow(row: RunRow): Run {
    let error: RunError | undefined;
    try {
      error = row.error_json ? JSON.parse(row.error_json) as RunError : undefined;
    } catch (cause) {
      throw persistenceError(`Run '${row.id}' contains invalid error data`, cause);
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      engine: row.engine,
      status: row.status as RunStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.output_message_id ? { outputMessageId: row.output_message_id } : {}),
      ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
      ...(error ? { error } : {}),
    };
  }
}

export function createRunRepository(databasePath?: string): RunRepository {
  return databasePath ? new SqliteRunRepository(databasePath) : new MemoryRunRepository();
}

function runNotFound(id: string): GatewayError {
  return new GatewayError(404, "RUN_NOT_FOUND", `Run '${id}' was not found`);
}

function persistenceError(message: string, error: unknown): GatewayError {
  return new GatewayError(
    500,
    "PERSISTENCE_ERROR",
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
