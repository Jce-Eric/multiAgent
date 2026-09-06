import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TransactionCoordinator {
  transaction<T>(operation: () => T): T;
  close(): void;
}

export class NoopTransactionCoordinator implements TransactionCoordinator {
  transaction<T>(operation: () => T): T {
    return operation();
  }

  close(): void {}
}

export class SqliteDatabase implements TransactionCoordinator {
  readonly connection: DatabaseSync;
  private depth = 0;
  private closed = false;

  constructor(databasePath: string) {
    const resolved = path.resolve(databasePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    this.connection = new DatabaseSync(resolved);
    this.connection.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
  }

  transaction<T>(operation: () => T): T {
    const level = this.depth;
    const savepoint = `gateway_transaction_${level}`;
    this.connection.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = operation();
      if (isPromiseLike(result)) {
        throw new TypeError("SQLite transaction operations must be synchronous");
      }
      this.connection.exec(level === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.connection.exec(
        level === 0
          ? "ROLLBACK"
          : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
      );
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as PromiseLike<unknown>).then === "function";
}

export function resolveSqliteDatabase(source: string | SqliteDatabase): {
  sqlite: SqliteDatabase;
  ownsDatabase: boolean;
} {
  return typeof source === "string"
    ? { sqlite: new SqliteDatabase(source), ownsDatabase: true }
    : { sqlite: source, ownsDatabase: false };
}
