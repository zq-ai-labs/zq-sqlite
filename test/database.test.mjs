import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, sql, ZqSqliteError } from '../lib/index.js'

const first = {
  '0001-notes': {
    async up(db) {
      await db.schema.createTable('notes').addColumn('id', 'text', c => c.primaryKey()).addColumn('text', 'text', c => c.notNull()).addColumn('done', 'integer', c => c.notNull().defaultTo(0)).execute()
    },
  },
}
const second = { ...first, '0002-tags': { async up(db) { await db.schema.alterTable('notes').addColumn('tag', 'text').execute() } } }
/** A temporary folder. Databases opened with `open` are closed before the folder is removed: Windows keeps open files. */
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zq-sqlite-')), opened = []
  t.after(async () => { for (const store of opened) await store.close().catch(() => {}); await rm(dir, { recursive: true, force: true }) })
  const open = async options => { const store = await openDatabase({ dir, name: 'plugin', ...options }); opened.push(store); return store }
  return { dir, open }
}

test('creates the database with WAL, applies migrations and keeps data across reopen', async t => {
  const { dir, open } = await folder(t)
  let store = await open({ migrations: first })
  assert.match(store.sqliteVersion, /^3\.\d+/)
  assert.equal(store.file, join(dir, 'plugin.sqlite'))
  assert.equal((await sql`pragma journal_mode`.execute(store.db)).rows[0].journal_mode, 'wal')
  assert.equal((await sql`pragma foreign_keys`.execute(store.db)).rows[0].foreign_keys, 1)
  await store.db.insertInto('notes').values({ id: 'a', text: '第一条', done: true }).execute()
  await store.close()
  store = await open({ migrations: first })
  assert.deepEqual(await store.db.selectFrom('notes').selectAll().execute(), [{ id: 'a', text: '第一条', done: 1 }])
  assert.equal((await readdir(dir)).includes('backups'), false, 'no upgrade, no backup')
})

test('an upgrade backs up the old database first and keeps only the latest copies', async t => {
  const { dir, open } = await folder(t)
  let store = await open({ migrations: first })
  await store.db.insertInto('notes').values({ id: 'a', text: '升级前' }).execute()
  await store.close()
  store = await open({ migrations: second, keepBackups: 1 })
  await store.db.updateTable('notes').set({ tag: 'x' }).execute()
  await store.close()
  const copies = await readdir(join(dir, 'backups'))
  assert.equal(copies.length, 1)
  assert.match(copies[0], /^plugin-\d{8}T\d{6}-before-0002-tags\.sqlite$/)
  const old = new DatabaseSync(join(dir, 'backups', copies[0]))
  assert.deepEqual(old.prepare('select id, text from notes').all().map(row => ({ ...row })), [{ id: 'a', text: '升级前' }])
  assert.equal(old.prepare("select count(*) as n from pragma_table_info('notes') where name = 'tag'").get().n, 0, 'the copy is from before the upgrade')
  old.close()
})

test('a database written by a newer version is refused, not changed', async t => {
  const { dir, open } = await folder(t)
  await (await open({ migrations: second })).close()
  const before = (await stat(join(dir, 'plugin.sqlite'))).mtimeMs
  await assert.rejects(open({ migrations: first }), error => error instanceof ZqSqliteError && error.code === 'database-newer')
  assert.equal((await stat(join(dir, 'plugin.sqlite'))).mtimeMs, before)
})

test('a failing migration rolls back entirely', async t => {
  const { dir, open } = await folder(t)
  await (await open({ migrations: first })).close()
  const broken = { ...first, '0002-half': { async up(db) { await db.schema.alterTable('notes').addColumn('tag', 'text').execute(); throw new Error('boom') } } }
  await assert.rejects(open({ migrations: broken }), error => error.code === 'migration-failed')
  const check = new DatabaseSync(join(dir, 'plugin.sqlite'))
  assert.equal(check.prepare("select count(*) as n from pragma_table_info('notes') where name = 'tag'").get().n, 0)
  assert.deepEqual(check.prepare('select name from zq_migrations').all().map(row => row.name), ['0001-notes'])
  check.close()
})

test('transactions commit or roll back as a whole, and concurrent ones do not interleave', async t => {
  const { open } = await folder(t)
  const store = await open({ migrations: first })
  await store.transaction(async tx => { await tx.insertInto('notes').values({ id: 'a', text: 'one' }).execute() })
  await assert.rejects(store.transaction(async tx => { await tx.insertInto('notes').values({ id: 'b', text: 'two' }).execute(); throw new Error('stop') }), /stop/)
  assert.deepEqual((await store.db.selectFrom('notes').select('id').execute()).map(row => row.id), ['a'])
  await store.db.insertInto('notes').values({ id: 'counter', text: '0' }).execute()
  await Promise.all(Array.from({ length: 50 }, () => store.transaction(async tx => {
    const { text } = await tx.selectFrom('notes').select('text').where('id', '=', 'counter').executeTakeFirstOrThrow()
    await new Promise(resolve => setImmediate(resolve))
    await tx.updateTable('notes').set({ text: String(Number(text) + 1) }).where('id', '=', 'counter').execute()
  })))
  assert.equal((await store.db.selectFrom('notes').select('text').where('id', '=', 'counter').executeTakeFirstOrThrow()).text, '50')
})

test('binds booleans and null, returns rows from RETURNING and counts affected rows', async t => {
  const { open } = await folder(t)
  const store = await open({ migrations: second })
  const inserted = await store.db.insertInto('notes').values({ id: 'a', text: 'x', done: false, tag: null }).returning(['id', 'done']).executeTakeFirstOrThrow()
  assert.deepEqual(inserted, { id: 'a', done: 0 })
  assert.equal((await store.db.updateTable('notes').set({ done: true }).where('id', '=', 'a').executeTakeFirstOrThrow()).numUpdatedRows, 1n)
  assert.equal((await store.db.updateTable('notes').set({ done: true }).where('id', '=', 'nope').executeTakeFirstOrThrow()).numUpdatedRows, 0n)
  await assert.rejects(store.db.insertInto('notes').values({ id: 'b', text: { not: 'json' } }).execute(), /cannot bind/)
  const conflict = await store.db.insertInto('notes').values({ id: 'a', text: 'again' }).onConflict(oc => oc.doNothing()).executeTakeFirstOrThrow()
  assert.equal(conflict.numInsertedOrUpdatedRows, 0n)
})

test('backup writes a consistent copy and the integrity check passes', async t => {
  const { dir, open } = await folder(t)
  const store = await open({ migrations: first })
  await store.db.insertInto('notes').values({ id: 'a', text: '备份' }).execute()
  const target = join(dir, "copy 'quoted'.sqlite")
  await store.backup(target)
  const copy = new DatabaseSync(target)
  assert.equal(copy.prepare('select text from notes').get().text, '备份')
  copy.close()
  assert.deepEqual(await store.check(), { ok: true })
})

test('rejects unsafe database names', async t => {
  const { open } = await folder(t)
  await assert.rejects(open({ name: '../escape', migrations: first }), error => error.code === 'unsupported')
})
