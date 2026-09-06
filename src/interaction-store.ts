import { DatabaseSync } from "node:sqlite";
import { GatewayError } from "./errors.js";
import { resolveSqliteDatabase, type SqliteDatabase } from "./sqlite-database.js";
import type {
  Interaction,
  InteractionStatus,
  InteractionType,
  PermissionResponse,
  QuestionResponse,
} from "./types.js";
import { now } from "./utils.js";

export interface InteractionRepository {
  add(interaction: Interaction): void;
  save(interaction: Interaction): void;
  get(id: string): Interaction;
  listForSession(sessionId: string): Interaction[];
  listForRun(runId: string): Interaction[];
  health(): boolean;
  close(): void;
}

export class MemoryInteractionRepository implements InteractionRepository {
  private readonly interactions = new Map<string, Interaction>();

  add(interaction: Interaction): void {
    this.interactions.set(interaction.id, interaction);
  }

  save(interaction: Interaction): void {
    this.interactions.set(interaction.id, interaction);
  }

  get(id: string): Interaction {
    const interaction = this.interactions.get(id);
    if (!interaction) throw interactionNotFound(id);
    return interaction;
  }

  listForSession(sessionId: string): Interaction[] {
    return this.list().filter((interaction) => interaction.sessionId === sessionId);
  }

  listForRun(runId: string): Interaction[] {
    return this.list().filter((interaction) => interaction.runId === runId);
  }

  health(): boolean {
    return true;
  }

  close(): void {}

  private list(): Interaction[] {
    return [...this.interactions.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }
}

interface InteractionRow {
  id: string;
  session_id: string;
  run_id: string;
  type: string;
  status: string;
  data_json: string;
  response_json: string | null;
  resolved_by: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export class SqliteInteractionRepository implements InteractionRepository {
  private readonly database: DatabaseSync;
  private readonly sqlite: SqliteDatabase;
  private readonly ownsDatabase: boolean;

  constructor(databasePath: string | SqliteDatabase) {
    const resolved = resolveSqliteDatabase(databasePath);
    this.sqlite = resolved.sqlite;
    this.ownsDatabase = resolved.ownsDatabase;
    this.database = this.sqlite.connection;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('question', 'permission')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'canceled')),
        data_json TEXT NOT NULL,
        response_json TEXT,
        resolved_by TEXT,
        cancel_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS interactions_session_created_idx
        ON interactions(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS interactions_run_created_idx
        ON interactions(run_id, created_at DESC);
    `);
    const timestamp = now();
    this.database.prepare(`
      UPDATE interactions
      SET status = 'canceled', updated_at = ?, resolved_at = ?,
          cancel_reason = 'GATEWAY_RESTARTED'
      WHERE status = 'pending'
    `).run(timestamp, timestamp);
  }

  add(interaction: Interaction): void {
    try {
      this.database.prepare(`
        INSERT INTO interactions
          (id, session_id, run_id, type, status, data_json, response_json,
           resolved_by, cancel_reason, created_at, updated_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...this.values(interaction));
    } catch (error) {
      throw persistenceError(`Could not persist interaction '${interaction.id}'`, error);
    }
  }

  save(interaction: Interaction): void {
    try {
      this.database.prepare(`
        UPDATE interactions
        SET session_id = ?, run_id = ?, type = ?, status = ?, data_json = ?,
            response_json = ?, resolved_by = ?, cancel_reason = ?, created_at = ?,
            updated_at = ?, resolved_at = ?
        WHERE id = ?
      `).run(
        interaction.sessionId,
        interaction.runId,
        interaction.type,
        interaction.status,
        JSON.stringify(interaction.data),
        interaction.response === undefined ? null : JSON.stringify(interaction.response),
        interaction.resolvedBy ?? null,
        interaction.cancelReason ?? null,
        interaction.createdAt,
        interaction.updatedAt,
        interaction.resolvedAt ?? null,
        interaction.id,
      );
    } catch (error) {
      throw persistenceError(`Could not update interaction '${interaction.id}'`, error);
    }
  }

  get(id: string): Interaction {
    const row = this.database.prepare("SELECT * FROM interactions WHERE id = ?").get(id) as
      | InteractionRow
      | undefined;
    if (!row) throw interactionNotFound(id);
    return this.fromRow(row);
  }

  listForSession(sessionId: string): Interaction[] {
    const rows = this.database.prepare(
      "SELECT * FROM interactions WHERE session_id = ? ORDER BY created_at DESC",
    ).all(sessionId) as unknown as InteractionRow[];
    return rows.map((row) => this.fromRow(row));
  }

  listForRun(runId: string): Interaction[] {
    const rows = this.database.prepare(
      "SELECT * FROM interactions WHERE run_id = ? ORDER BY created_at DESC",
    ).all(runId) as unknown as InteractionRow[];
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
    if (this.ownsDatabase) this.sqlite.close();
  }

  private values(interaction: Interaction): [
    string,
    string,
    string,
    InteractionType,
    InteractionStatus,
    string,
    string | null,
    string | null,
    string | null,
    string,
    string,
    string | null,
  ] {
    return [
      interaction.id,
      interaction.sessionId,
      interaction.runId,
      interaction.type,
      interaction.status,
      JSON.stringify(interaction.data),
      interaction.response === undefined ? null : JSON.stringify(interaction.response),
      interaction.resolvedBy ?? null,
      interaction.cancelReason ?? null,
      interaction.createdAt,
      interaction.updatedAt,
      interaction.resolvedAt ?? null,
    ];
  }

  private fromRow(row: InteractionRow): Interaction {
    try {
      const response = row.response_json
        ? JSON.parse(row.response_json) as QuestionResponse | PermissionResponse
        : undefined;
      return {
        id: row.id,
        sessionId: row.session_id,
        runId: row.run_id,
        type: row.type as InteractionType,
        status: row.status as InteractionStatus,
        data: JSON.parse(row.data_json) as unknown,
        ...(response ? { response } : {}),
        ...(row.resolved_by ? { resolvedBy: row.resolved_by as "client" | "policy" } : {}),
        ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
      };
    } catch (error) {
      throw persistenceError(`Interaction '${row.id}' contains invalid data`, error);
    }
  }
}

export function createInteractionRepository(databasePath?: string): InteractionRepository {
  return databasePath
    ? new SqliteInteractionRepository(databasePath)
    : new MemoryInteractionRepository();
}

function interactionNotFound(id: string): GatewayError {
  return new GatewayError(404, "INTERACTION_NOT_FOUND", `Interaction '${id}' was not found`);
}

function persistenceError(message: string, error: unknown): GatewayError {
  return new GatewayError(
    500,
    "PERSISTENCE_ERROR",
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
