import { Kysely } from 'kysely';
import { type Migration } from 'kysely/migration';
export * from 'kysely';
export type { Migration } from 'kysely/migration';
export { NodeSqliteDialect } from './dialect.js';
export { searchQuery, searchTokens } from './search.js';
/** Errors with a stable `code`, so each plugin can show its own wording. */
export declare class ZqSqliteError extends Error {
    readonly code: 'database-newer' | 'migration-failed' | 'unsupported' | 'busy' | 'unreadable';
    constructor(message: string, code: 'database-newer' | 'migration-failed' | 'unsupported' | 'busy' | 'unreadable', options?: {
        cause?: unknown;
    });
}
export interface OpenOptions {
    /** The plugin's own data folder; created with owner-only access when missing. */
    dir: string;
    /** File name without extension, e.g. `workbench` → `workbench.sqlite`. */
    name: string;
    /** Kysely migrations, applied in name order inside one transaction. Never edit or remove one that has shipped. */
    migrations: Record<string, Migration>;
    /** `full` syncs every commit to disk; `normal` may lose the last commits on power loss. Default `full`. */
    durability?: 'full' | 'normal';
    /** How long a writer waits for another process holding the lock. Default 5000 ms. */
    busyTimeoutMs?: number;
    /** Fail early when the runtime's SQLite has no FTS5. Default true. */
    requireFts5?: boolean;
    /** Copies kept in `<dir>/backups` from before each upgrade. Default 3. */
    keepBackups?: number;
}
export interface SqliteDatabase<DB> {
    readonly db: Kysely<DB>;
    readonly file: string;
    readonly sqliteVersion: string;
    /** Run work in one write transaction (BEGIN IMMEDIATE). Do no network or file I/O inside: it holds the database. */
    transaction<T>(work: (tx: Kysely<DB>) => Promise<T>): Promise<T>;
    /** A consistent copy of the whole database at `target`. */
    backup(target: string): Promise<void>;
    /** SQLite's quick integrity check. */
    check(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    close(): Promise<void>;
}
/**
 * Open (or create) a plugin's database: WAL journal, busy timeout, foreign keys, checks for the features plugins rely
 * on, then pending migrations — after a backup when the database already had data.
 */
export declare function openDatabase<DB>(options: OpenOptions): Promise<SqliteDatabase<DB>>;
