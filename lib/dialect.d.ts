import type { DatabaseSync } from 'node:sqlite';
import { type DatabaseIntrospector, type Dialect, type DialectAdapter, type Driver, type Kysely, type QueryCompiler } from 'kysely';
/** Kysely dialect over Node's built-in node:sqlite, for a database the caller has already opened and configured. */
export declare class NodeSqliteDialect implements Dialect {
    private readonly database;
    constructor(database: DatabaseSync);
    createAdapter(): DialectAdapter;
    createDriver(): Driver;
    createQueryCompiler(): QueryCompiler;
    createIntrospector(db: Kysely<any>): DatabaseIntrospector;
}
