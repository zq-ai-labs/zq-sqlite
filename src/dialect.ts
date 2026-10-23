import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  CompiledQuery, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler,
  type DatabaseConnection, type DatabaseIntrospector, type Dialect, type DialectAdapter, type Driver, type Kysely, type QueryCompiler, type QueryResult,
} from 'kysely'

/** SQLite runs DDL inside transactions, so a failed upgrade leaves the database exactly as it was. */
class TransactionalSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean { return true }
}

type Value = null | number | bigint | string | Uint8Array
/** node:sqlite binds only null, numbers, bigints, strings and bytes. */
function bind(value: unknown): Value {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value
  if (value instanceof Date) return value.toISOString()
  throw new TypeError(`zq-sqlite cannot bind a ${typeof value} parameter; serialize it first (for example JSON.stringify)`)
}
/** Statements that return rows. Used only when StatementSync.columns() is unavailable. */
const READER = /^\s*(?:select|with|pragma|values|explain)\b|\breturning\b/i
const CACHE_LIMIT = 500

class NodeSqliteConnection implements DatabaseConnection {
  private readonly cache = new Map<string, StatementSync>()
  constructor(readonly database: DatabaseSync) {}
  private statement(sql: string): StatementSync {
    let statement = this.cache.get(sql)
    if (statement) { this.cache.delete(sql); this.cache.set(sql, statement); return statement }
    statement = this.database.prepare(sql)
    this.cache.set(sql, statement)
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!)
    return statement
  }
  private reader(statement: StatementSync, sql: string): boolean {
    return typeof statement.columns === 'function' ? statement.columns().length > 0 : READER.test(sql)
  }
  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.statement(query.sql), parameters = query.parameters.map(bind)
    // node:sqlite rows have a null prototype; callers get ordinary objects.
    if (this.reader(statement, query.sql)) return { rows: statement.all(...parameters).map(row => ({ ...row })) as R[] }
    const { changes, lastInsertRowid } = statement.run(...parameters)
    return { rows: [], numAffectedRows: BigInt(changes), insertId: BigInt(lastInsertRowid) }
  }
  async *streamQuery<R>(query: CompiledQuery, chunkSize = 100): AsyncIterableIterator<QueryResult<R>> {
    const statement = this.statement(query.sql), parameters = query.parameters.map(bind)
    let rows: R[] = []
    for (const row of statement.iterate(...parameters)) {
      rows.push({ ...row } as R)
      if (rows.length >= chunkSize) { yield { rows }; rows = [] }
    }
    if (rows.length) yield { rows }
  }
}

/** One connection, used by one caller at a time. node:sqlite is synchronous, so this only orders the awaits around it. */
class ConnectionMutex {
  private tail: Promise<void> = Promise.resolve()
  private release?: () => void
  async lock(): Promise<void> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    this.release = release
  }
  unlock(): void { const release = this.release; this.release = undefined; release?.() }
}

class NodeSqliteDriver implements Driver {
  private connection?: NodeSqliteConnection
  private readonly mutex = new ConnectionMutex()
  constructor(private readonly database: DatabaseSync) {}
  async init(): Promise<void> { this.connection = new NodeSqliteConnection(this.database) }
  async acquireConnection(): Promise<DatabaseConnection> { await this.mutex.lock(); return this.connection! }
  /** IMMEDIATE takes the write lock up front, so two processes never deadlock upgrading a read to a write. */
  async beginTransaction(connection: DatabaseConnection): Promise<void> { await connection.executeQuery(CompiledQuery.raw('begin immediate')) }
  async commitTransaction(connection: DatabaseConnection): Promise<void> { await connection.executeQuery(CompiledQuery.raw('commit')) }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> { await connection.executeQuery(CompiledQuery.raw('rollback')) }
  async releaseConnection(): Promise<void> { this.mutex.unlock() }
  async destroy(): Promise<void> { if (this.database.isOpen) this.database.close() }
}

/** Kysely dialect over Node's built-in node:sqlite, for a database the caller has already opened and configured. */
export class NodeSqliteDialect implements Dialect {
  constructor(private readonly database: DatabaseSync) {}
  createAdapter(): DialectAdapter { return new TransactionalSqliteAdapter() }
  createDriver(): Driver { return new NodeSqliteDriver(this.database) }
  createQueryCompiler(): QueryCompiler { return new SqliteQueryCompiler() }
  createIntrospector(db: Kysely<any>): DatabaseIntrospector { return new SqliteIntrospector(db) }
}
