# zq-sqlite

ZQ DSH 插件共用的 SQLite 基础包：基于 Node 自带的 `node:sqlite`，用 [Kysely](https://kysely.dev) 写查询，负责打开数据库、事务、迁移（升级前自动备份）、Windows 文件占用重试和中文全文搜索。

设计背景见 bkms-workbench 的 `docs/DESIGN-CORE-CHANNELS.md`（§5.7、§5.10）。约定：

- **每个插件一个库文件**，放在插件自己的数据目录。插件之间要用对方的数据时调用对方的服务接口，不直接打开别人的库，也不用 `ATTACH`。
- **事务里不做网络或文件 IO**：事务期间占着数据库，IMAP、SMTP、模型调用都放在事务外。
- **迁移只增不改**：已发布的迁移不再修改或删除；数据库版本比插件新时拒绝打开（`database-newer`），不支持降级。

## 要求

- Node `^22.19.0 || >=24.0.0`（与 DSH 一致）。Node 22 首次使用 `node:sqlite` 时打印一条实验性警告；打包版 XBuddy 的 Node 24.21.0 不打印。
- 运行时自带的 SQLite 需要 FTS5（已在 Node 22.23.1 / SQLite 3.51.3 和 Node 24.21.0 / SQLite 3.53.4 上确认）。
- 没有原生模块，只依赖 `kysely`。

## 用法

```ts
import { openDatabase, type Generated, type Migration } from 'zq-sqlite'

interface DB { notes: { id: string; text: string; done: number } }
const migrations: Record<string, Migration> = {
  '0001-notes': { async up(db) { await db.schema.createTable('notes').addColumn('id', 'text', c => c.primaryKey()).addColumn('text', 'text', c => c.notNull()).addColumn('done', 'integer', c => c.notNull().defaultTo(0)).execute() } },
}

const store = await openDatabase<DB>({ dir: '<插件数据目录>', name: 'my-plugin', migrations })
await store.transaction(async tx => {
  await tx.insertInto('notes').values({ id: 'a', text: '第一条', done: 0 }).execute()
})
const rows = await store.db.selectFrom('notes').selectAll().execute()
await store.close()
```

`openDatabase` 选项：

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `dir` | 必填 | 插件数据目录，不存在时以仅所有者可访问的权限创建 |
| `name` | 必填 | 文件名（不含扩展名），只允许字母、数字、`_`、`-` |
| `migrations` | 必填 | Kysely 迁移，按名称排序、在一个事务里执行 |
| `durability` | `full` | `full` 每次提交都同步到磁盘；`normal` 断电可能丢最后几次提交 |
| `busyTimeoutMs` | `5000` | 其他进程持有写锁时的等待时间 |
| `requireFts5` | `true` | 运行时没有 FTS5 时直接报错 |
| `keepBackups` | `3` | `<dir>/backups` 中保留的升级前备份份数 |

返回对象：`db`（Kysely 实例）、`file`、`sqliteVersion`、`transaction(work)`（`BEGIN IMMEDIATE`）、`backup(target)`（一致性副本）、`check()`（`quick_check`）、`close()`。包同时转出 Kysely 的全部接口（`sql`、`Kysely`、类型等），插件只需依赖本包。

错误：`ZqSqliteError`，按 `code` 判断——`database-newer`（库由更新版本写入）、`migration-failed`（迁移失败，已整体回滚）、`unsupported`（缺 FTS5、名称无效）、`busy`（文件持续被占用）、`unreadable`（无法打开）。各插件用自己的文案提示用户。

## 中文全文搜索

`searchTokens(text)` 把连续的中日韩文字切成重叠的两字组（“合同条款” → “合同 同条 条款”），其他文字按词并转小写；写入 FTS5（`tokenize='unicode61'`）的列。`searchQuery(input)` 把用户输入转成 MATCH 表达式：空格分开的每个词都要出现，一个词内的字必须相邻且有序。常用的两字词能走索引；单个汉字只能按前缀匹配。

```sql
create virtual table docs using fts5(doc_id unindexed, text, tokenize='unicode61');
```

## 在插件中使用

以 Git 依赖固定到标签，仓库里提交了编译好的 `lib/`，安装时不需要构建（pnpm 默认不执行依赖的安装脚本）：

```json
"dependencies": { "zq-sqlite": "git+https://github.com/zq-ai-labs/zq-sqlite.git#v0.1.0" }
```

## 开发

```bash
pnpm install --frozen-lockfile
pnpm test        # 编译后运行 test/*.test.mjs
```

发布：改 `package.json` 版本 → `pnpm run build` → 提交 `lib/` → 打标签 `vX.Y.Z` → 各插件把依赖改到新标签。
