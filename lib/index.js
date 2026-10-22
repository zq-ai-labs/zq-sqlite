import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { NodeSqliteDialect } from './dialect.js';
export * from 'kysely';
export { NodeSqliteDialect } from './dialect.js';
export { searchQuery, searchTokens } from './search.js';
/** Errors with a stable `code`, so each plugin can show its own wording. */
export class ZqSqliteError extends Error {
    code;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
    }
}
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (path) => `'${path.replaceAll("'", "''")}'`;
/** Opening can fail for a moment on Windows while antivirus or the indexer holds the file. */
async function openFile(file) {
    for (let attempt = 1;; attempt++) {
        try {
            return new DatabaseSync(file);
        }
        catch (error) {
            const code = error.code ?? '';
            const transient = LOCKED.has(code) || /unable to open|database is locked|busy/i.test(String(error.message));
            if (!transient || attempt >= 10)
                throw new ZqSqliteError(`Cannot open ${file}: ${error.message}`, transient ? 'busy' : 'unreadable', { cause: error });
            await wait(Math.min(50 * attempt, 400));
        }
    }
}
async function backups(dir, name) {
    try {
        return (await readdir(join(dir, 'backups'))).filter(file => file.startsWith(`${name}-`) && file.endsWith('.sqlite')).sort();
    }
    catch {
        return [];
    }
}
/**
 * Open (or create) a plugin's database: WAL journal, busy timeout, foreign keys, checks for the features plugins rely
 * on, then pending migrations — after a backup when the database already had data.
 */
export async function openDatabase(options) {
    const { dir, name, migrations, durability = 'full', busyTimeoutMs = 5000, requireFts5 = true, keepBackups = 3 } = options;
    if (!/^[\w-]{1,80}$/.test(name))
        throw new ZqSqliteError(`Invalid database name: ${name}`, 'unsupported');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${name}.sqlite`);
    // Owner-only from the first byte; an existing file keeps its mode.
    try {
        await (await open(file, 'wx', 0o600)).close();
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const database = await openFile(file);
    let db;
    try {
        database.exec(`pragma busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
        database.exec('pragma journal_mode = wal');
        database.exec(`pragma synchronous = ${durability === 'normal' ? 'normal' : 'full'}`);
        database.exec('pragma foreign_keys = on');
        const sqliteVersion = String(database.prepare('select sqlite_version() as v').get().v);
        if (requireFts5) {
            try {
                database.exec('create virtual table temp.zq_fts5_probe using fts5(x); drop table temp.zq_fts5_probe');
            }
            catch (error) {
                throw new ZqSqliteError(`This runtime's SQLite ${sqliteVersion} has no FTS5`, 'unsupported', { cause: error });
            }
        }
        db = new Kysely({ dialect: new NodeSqliteDialect(database) });
        const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations }, migrationTableName: 'zq_migrations', migrationLockTableName: 'zq_migrations_lock' });
        let pending;
        try {
            pending = (await migrator.getMigrations()).filter(item => !item.executedAt).map(item => item.name);
        }
        catch (error) {
            throw newer(error) ?? error;
        }
        const applied = Object.keys(migrations).length - pending.length;
        if (pending.length && applied > 0) {
            // An upgrade of a database that already holds data: keep a copy first.
            await mkdir(join(dir, 'backups'), { recursive: true, mode: 0o700 });
            const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
            database.exec(`vacuum into ${quote(join(dir, 'backups', `${name}-${stamp}-before-${pending[0]}.sqlite`))}`);
            const kept = await backups(dir, name);
            for (const old of kept.slice(0, Math.max(0, kept.length - keepBackups)))
                await rm(join(dir, 'backups', old), { force: true });
        }
        const { error } = await migrator.migrateToLatest();
        if (error)
            throw newer(error) ?? new ZqSqliteError(`Migration of ${file} failed: ${error?.message ?? error}`, 'migration-failed', { cause: error });
        const kysely = db;
        return {
            db: kysely, file, sqliteVersion,
            transaction: work => kysely.transaction().execute(work),
            async backup(target) { await sql `vacuum into ${sql.raw(quote(target))}`.execute(kysely); },
            async check() {
                const rows = (await sql `pragma quick_check`.execute(kysely)).rows;
                const detail = rows.map(row => row.quick_check).join('; ');
                return detail === 'ok' ? { ok: true } : { ok: false, detail };
            },
            close: () => kysely.destroy(),
        };
    }
    catch (error) {
        if (db)
            await db.destroy().catch(() => { });
        else if (database.isOpen)
            database.close();
        throw error;
    }
}
/** A database that ran migrations this plugin does not know was written by a newer version. */
function newer(error) {
    const message = String(error?.message ?? error);
    if (!/corrupted migrations/i.test(message))
        return undefined;
    return new ZqSqliteError('The database was written by a newer version; upgrade the plugin to open it', 'database-newer', { cause: error });
}
