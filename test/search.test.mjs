import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, searchQuery, searchTokens, sql } from '../lib/index.js'

test('tokens: Chinese runs become overlapping pairs, other words are lowercased', () => {
  assert.equal(searchTokens('合同条款 Quote-2026 发'), '合同 同条 条款 quote 2026 发')
  assert.equal(searchTokens('ＡＢＣ　１２３'), 'abc 123', 'full-width forms are normalized')
  assert.equal(searchTokens('！？。'), '')
})

test('queries: every term must appear and a term is a phrase', () => {
  assert.equal(searchQuery('报价'), '"报价"')
  assert.equal(searchQuery('付款确认 PO'), '"付款 款确 确认" "po"')
  assert.equal(searchQuery('合'), '"合"*', 'a single character searches by prefix')
  assert.equal(searchQuery('  ！ '), '')
})

test('FTS5 with unicode61 finds two-character words, phrases and English words', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zq-sqlite-search-'))
  const store = await openDatabase({ dir, name: 'search', migrations: { '0001': { async up(db) { await sql`create virtual table docs using fts5(doc_id unindexed, text, tokenize='unicode61')`.execute(db) } } } })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const docs = { a: '请确认 500 台的报价，PO-2026 已发出。', b: '合同条款里写明了付款确认的时间。', c: '会议改到周五。', d: '价报不是报价。' }
  for (const [id, text] of Object.entries(docs)) await sql`insert into docs (doc_id, text) values (${id}, ${searchTokens(text)})`.execute(store.db)
  const find = async input => (await sql`select doc_id from docs where docs match ${searchQuery(input)} order by doc_id`.execute(store.db)).rows.map(row => row.doc_id)
  assert.deepEqual(await find('报价'), ['a', 'd'])
  assert.deepEqual(await find('付款确认'), ['b'])
  assert.deepEqual(await find('确认 付款'), ['b'], 'terms in any order')
  assert.deepEqual(await find('确认'), ['a', 'b'])
  assert.deepEqual(await find('po'), ['a'])
  assert.deepEqual(await find('款付'), [], 'characters of a term must be adjacent and in order')
  assert.deepEqual(await find('会'), ['c'])
})
