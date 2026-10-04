import { join } from 'node:path'

import { createSqliteExtension, type SqliteDatabase } from '@atmos.build/extension/server'
import { z } from '@atmos.build/extension'

import {
  appDocument,
  createWorktree,
  extensionContract,
  listWorktrees,
  openWorktreesApp,
  removeWorktree,
  setPhone,
  startWorktree,
  stopWorktree,
  worktreeList,
  type Worktree,
} from './contract.ts'
import * as ops from './ops.ts'

const Row = z.object({
  name: z.string(),
  path: z.string(),
  gitBranch: z.string(),
  port: z.number().int(),
  phone: z.string().nullable(),
  neonBranchId: z.string(),
  neonBranchName: z.string(),
  createdAt: z.string(),
})
type Row = z.infer<typeof Row>
const SELECT = `SELECT name, path, git_branch AS gitBranch, port, phone, neon_branch_id AS neonBranchId,
  neon_branch_name AS neonBranchName, created_at AS createdAt FROM worktrees`

const extension = createSqliteExtension(extensionContract, { root: new URL('..', import.meta.url) })

function rows(db: SqliteDatabase) {
  return db.all(Row, `${SELECT} ORDER BY created_at`)
}
function rowFor(db: SqliteDatabase, name: string) {
  const row = db.maybe(Row, `${SELECT} WHERE name = ?`, name)
  if (!row) throw new ops.DomainError(`No worktree named "${name}".`)
  return row
}

async function describe(list: Row[]): Promise<Worktree[]> {
  const live = await Promise.all(
    list.map(async (r) => ({ ...r, ...(await ops.processState(r.name, r.path, r.port)), ...(await ops.gitState(r.path)) })),
  )
  const routes = await ops.routeStates(live)
  return live.map((w) => ({ ...w, route: routes.get(w.name) ?? { status: 'unknown', expiresAt: null, message: null } }))
}
async function describeOne(db: SqliteDatabase, name: string): Promise<Worktree> {
  const [worktree] = await describe([rowFor(db, name)])
  if (!worktree) throw new ops.DomainError(`No worktree named "${name}".`)
  return worktree
}

// One mutation at a time: port allocation and route moves must not interleave.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => {}).then(job)
  queue = next
  return next.finally(() => {
    extension.mcp.server.sendResourceUpdated({ uri: worktreeList.uri }).catch(() => {})
  })
}

/** Points prod's route for the phone at this worktree, or explains why not. Never throws. */
async function routeTo(row: Row, publicUrl: string | null, notes: string[]) {
  if (!row.phone) return
  if (!publicUrl) {
    notes.push(`Not routing ${row.phone}: the worktree has no tunnel. Start it first.`)
    return
  }
  await ops.upsertRoute(row.phone, row.name, publicUrl).then(
    () => notes.push(`${row.phone} → ${row.name} for ${ops.config.routeTtlHours}h (start again to renew).`),
    (err: Error) => notes.push(`Could not route ${row.phone} in production: ${err.message}`),
  )
}
async function unroute(row: Row, notes: string[]) {
  if (!row.phone) return
  await ops.deleteRoute(row.phone, row.name).catch((err: Error) => notes.push(`Could not drop the production route for ${row.phone}: ${err.message}`))
}

extension.resource(worktreeList, async ({ db }) => ({ repo: ops.config.repo, worktrees: await describe(rows(db)) }))
extension.tool(listWorktrees, async ({ db }) => ({ repo: ops.config.repo, worktrees: await describe(rows(db)) }))

extension.tool(createWorktree, (context, input) =>
  serial(async () => {
    const { db } = context
    const { name, phone, baseRef, start } = input
    if (db.maybe(Row, `${SELECT} WHERE name = ?`, name)) throw new ops.DomainError(`A worktree named "${name}" already exists.`)
    const path = join(ops.config.worktreesDir, name)
    const gitBranch = `wt/${name}`
    const neonBranchName = `wt/${name}`
    const used = new Set(rows(db).map((r) => r.port))
    let port = ops.config.basePort
    while (used.has(port)) port++
    const notes: string[] = []

    await ops.gitAddWorktree(path, gitBranch, baseRef)
    let neon: { id: string; databaseUrl: string } | undefined
    try {
      neon = await ops.neonCreateBranch(neonBranchName)
      await ops.writeWorktreeEnv(path, {
        DATABASE_URL: neon.databaseUrl,
        NEON_BRANCH: neonBranchName,
        PORT: String(port),
        PUBLIC_URL: '',
        WORKTREE_NAME: name,
        DEV_PHONE: phone ?? '',
        // Empty = no outbound WhatsApp at all; the branch holds real users' numbers.
        WHATSAPP_ALLOWLIST: phone ?? '',
        TWILIO_SKIP_SIGNATURE: '0',
        WHATSAPP_ROUTER: null,
        NGROK_DOMAIN: null,
      }, true)
      await ops.linkNodeModules(path)
      await ops.migrate(path)
    } catch (err) {
      // Leave nothing half-made behind.
      if (neon) await ops.neonDeleteBranch(neon.id).catch(() => {})
      await ops.gitRemoveWorktree(path).catch(() => {})
      throw err
    }

    if (phone) db.run(`UPDATE worktrees SET phone = NULL WHERE phone = ?`, phone)
    db.run(
      `INSERT INTO worktrees (name, path, git_branch, port, phone, neon_branch_id, neon_branch_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      name, path, gitBranch, port, phone ?? null, neon.id, neonBranchName, new Date().toISOString(),
    )
    if (start) {
      const url = await ops.startProcesses(name, path, port).catch((err: Error) => {
        notes.push(`Created, but starting failed: ${err.message}`)
        return null
      })
      await routeTo(rowFor(db, name), url, notes)
    }
    return { worktree: await describeOne(db, name), notes }
  }),
)

extension.tool(removeWorktree, ({ db }, { name, force }) =>
  serial(async () => {
    const row = rowFor(db, name)
    const notes: string[] = []
    const git = await ops.gitState(row.path)
    if (git.dirtyFiles && !force) {
      throw new ops.DomainError(`"${name}" has ${git.dirtyFiles} uncommitted file(s). Commit them, or remove with force.`)
    }
    await ops.stopUnits(name)
    await unroute(row, notes)
    await ops.neonDeleteBranch(row.neonBranchId)
    await ops.gitRemoveWorktree(row.path)
    db.run(`DELETE FROM worktrees WHERE name = ?`, name)
    notes.push(`Kept git branch ${row.gitBranch}${git.aheadOfMain ? ` (${git.aheadOfMain} commit(s) ahead of main)` : ''}.`)
    return { removed: name, notes }
  }),
)

extension.tool(setPhone, ({ db }, { name, phone }) =>
  serial(async () => {
    const row = rowFor(db, name)
    const notes: string[] = []
    if (row.phone && row.phone !== phone) await unroute(row, notes)
    if (phone) {
      // A number belongs to one worktree: take it from whoever had it.
      const previous = db.maybe(Row, `${SELECT} WHERE phone = ? AND name != ?`, phone, name)
      if (previous) {
        await ops.writeWorktreeEnv(previous.path, { DEV_PHONE: '', WHATSAPP_ALLOWLIST: '' })
        db.run(`UPDATE worktrees SET phone = NULL WHERE name = ?`, previous.name)
        notes.push(`Moved ${phone} away from ${previous.name} (restart it to apply its empty allowlist).`)
      }
    }
    db.run(`UPDATE worktrees SET phone = ? WHERE name = ?`, phone, name)
    await ops.writeWorktreeEnv(row.path, { DEV_PHONE: phone ?? '', WHATSAPP_ALLOWLIST: phone ?? '' })
    const state = await ops.processState(name, row.path, row.port)
    let url = state.publicUrl
    if (state.app !== 'stopped') {
      // The allowlist is read at startup.
      url = await ops.startProcesses(name, row.path, row.port).catch((err: Error) => {
        notes.push(`Restart failed: ${err.message}`)
        return null
      })
    }
    await routeTo(rowFor(db, name), url, notes)
    return { worktree: await describeOne(db, name), notes }
  }),
)

extension.tool(startWorktree, ({ db }, { name }) =>
  serial(async () => {
    const row = rowFor(db, name)
    const notes: string[] = []
    const url = await ops.startProcesses(name, row.path, row.port)
    await routeTo(row, url, notes)
    return { worktree: await describeOne(db, name), notes }
  }),
)

extension.tool(stopWorktree, ({ db }, { name }) =>
  serial(async () => {
    const row = rowFor(db, name)
    const notes: string[] = []
    await ops.stopUnits(name)
    await unroute(row, notes)
    return { worktree: await describeOne(db, name), notes }
  }),
)

extension.app(appDocument)
extension.tool(openWorktreesApp, () => ({ ready: true }))

process.on('exit', () => void ops.closeProd())
await extension.listen()
