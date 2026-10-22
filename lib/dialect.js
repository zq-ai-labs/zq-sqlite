import { CompiledQuery, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, } from 'kysely';
/** SQLite runs DDL inside transactions, so a failed upgrade leaves the database exactly as it was. */
class TransactionalSqliteAdapter extends SqliteAdapter {
    get supportsTransactionalDdl() { return true; }
}
/** node:sqlite binds only null, numbers, bigints, strings and bytes. */
function bind(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === 'boolean')
        return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array)
        return value;
    if (value instanceof Date)
        return value.toISOString();
    throw new TypeError(`zq-sqlite cannot bind a ${typeof value} parameter; serialize it first (for example JSON.stringify)`);
}
/** Statements that return rows. Used only when StatementSync.columns() is unavailable. */
const READER = /^\s*(?:select|with|pragma|values|explain)\b|\breturning\b/i;
const CACHE_LIMIT = 500;
class NodeSqliteConnection {
    database;
    cache = new Map();
    constructor(database) {
        this.database = database;
    }
    statement(sql) {
        let statement = this.cache.get(sql);
        if (statement) {
            this.cache.delete(sql);
            this.cache.set(sql, statement);
            return statement;
        }
        statement = this.database.prepare(sql);
        this.cache.set(sql, statement);
        if (this.cache.size > CACHE_LIMIT)
            this.cache.delete(this.cache.keys().next().value);
        return statement;
    }
    reader(statement, sql) {
        return typeof statement.columns === 'function' ? statement.columns().length > 0 : READER.test(sql);
    }
    async executeQuery(query) {
        const statement = this.statement(query.sql), parameters = query.parameters.map(bind);
        // node:sqlite rows have a null prototype; callers get ordinary objects.
        if (this.reader(statement, query.sql))
            return { rows: statement.all(...parameters).map(row => ({ ...row })) };
        const { changes, lastInsertRowid } = statement.run(...parameters);
        return { rows: [], numAffectedRows: BigInt(changes), insertId: BigInt(lastInsertRowid) };
    }
    async *streamQuery(query, chunkSize = 100) {
        const statement = this.statement(query.sql), parameters = query.parameters.map(bind);
        let rows = [];
        for (const row of statement.iterate(...parameters)) {
            rows.push({ ...row });
            if (rows.length >= chunkSize) {
                yield { rows };
                rows = [];
            }
        }
        if (rows.length)
            yield { rows };
    }
}
/** One connection, used by one caller at a time. node:sqlite is synchronous, so this only orders the awaits around it. */
class ConnectionMutex {
    tail = Promise.resolve();
    release;
    async lock() {
        const previous = this.tail;
        let release;
        this.tail = new Promise(resolve => { release = resolve; });
        await previous;
        this.release = release;
    }
    unlock() { const release = this.release; this.release = undefined; release?.(); }
}
class NodeSqliteDriver {
    database;
    connection;
    mutex = new ConnectionMutex();
    constructor(database) {
        this.database = database;
    }
    async init() { this.connection = new NodeSqliteConnection(this.database); }
    async acquireConnection() { await this.mutex.lock(); return this.connection; }
    /** IMMEDIATE takes the write lock up front, so two processes never deadlock upgrading a read to a write. */
    async beginTransaction(connection) { await connection.executeQuery(CompiledQuery.raw('begin immediate')); }
    async commitTransaction(connection) { await connection.executeQuery(CompiledQuery.raw('commit')); }
    async rollbackTransaction(connection) { await connection.executeQuery(CompiledQuery.raw('rollback')); }
    async releaseConnection() { this.mutex.unlock(); }
    async destroy() { if (this.database.isOpen)
        this.database.close(); }
}
/** Kysely dialect over Node's built-in node:sqlite, for a database the caller has already opened and configured. */
export class NodeSqliteDialect {
    database;
    constructor(database) {
        this.database = database;
    }
    createAdapter() { return new TransactionalSqliteAdapter(); }
    createDriver() { return new NodeSqliteDriver(this.database); }
    createQueryCompiler() { return new SqliteQueryCompiler(); }
    createIntrospector(db) { return new SqliteIntrospector(db); }
}
