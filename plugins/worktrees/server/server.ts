import { join } from 'node:path'

import { createSqliteExtension } from '@atmos.build/extension/server'

import { App, onboard } from './chat.ts'
import {
  appDocument,
  chatMessages,
  chatOnboard,
  chatReset,
  chatSend,
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

const extension = createSqliteExtension(extensionContract, { root: new URL('..', import.meta.url) })

async function find(name: string) {
  const meta = (await ops.readRegistry()).find((m) => m.name === name)
  if (!meta) throw new ops.DomainError(`No worktree named "${name}".`)
  return meta
}

async function describe(list: ops.Meta[]): Promise<Worktree[]> {
  const live = await Promise.all(
    list.map(async (m) => ({ ...m, ...(await ops.processState(m.name, m.path, m.port)), ...(await ops.gitState(m.path)) })),
  )
  const routes = await ops.routeStates(live)
  return live.map((w) => ({ ...w, route: routes.get(w.name) ?? { status: 'unknown', expiresAt: null, message: null } }))
}
async function describeOne(name: string): Promise<Worktree> {
  const [worktree] = await describe([await find(name)])
  if (!worktree) throw new ops.DomainError(`No worktree named "${name}".`)
  return worktree
}
async function snapshot() {
  return { repo: ops.config.repo, worktrees: await describe(await ops.readRegistry()) }
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

/** Points prod's route for the phone at this worktree, or notes why not. Never throws. */
async function routeTo(meta: ops.Meta, publicUrl: string | null, notes: string[]) {
  if (!meta.phone) return
  if (!publicUrl) {
    notes.push(`Not routing ${meta.phone}: the worktree has no tunnel. Start it first.`)
    return
  }
  await ops.upsertRoute(meta.phone, meta.name, publicUrl).then(
    () => notes.push(`${meta.phone} → ${meta.name} for ${ops.config.routeTtlHours}h (start again to renew).`),
    (err: Error) => notes.push(`Could not route ${meta.phone} in production: ${err.message}`),
  )
}
async function unroute(meta: ops.Meta, notes: string[]) {
  if (!meta.phone) return
  await ops.deleteRoute(meta.phone, meta.name).catch((err: Error) => notes.push(`Could not drop the production route for ${meta.phone}: ${err.message}`))
}

/** A number belongs to one worktree: take it away from whoever had it. */
async function releasePhone(phone: string, except: string, notes: string[]) {
  for (const other of await ops.readRegistry()) {
    if (other.phone !== phone || other.name === except) continue
    await ops.writeMeta({ ...other, phone: null })
    await ops.writeWorktreeEnv(other.path, { DEV_PHONE: '', WHATSAPP_ALLOWLIST: '' })
    notes.push(`Moved ${phone} away from ${other.name} (restart it to apply its empty allowlist).`)
  }
}

extension.resource(worktreeList, snapshot)
extension.tool(listWorktrees, snapshot)

extension.tool(createWorktree, (_context, { name, phone, baseRef, start }) =>
  serial(async () => {
    const registry = await ops.readRegistry()
    if (registry.some((m) => m.name === name)) throw new ops.DomainError(`A worktree named "${name}" already exists.`)
    const path = join(ops.config.worktreesDir, name)
    const used = new Set(registry.map((m) => m.port))
    let port = ops.config.basePort
    while (used.has(port)) port++
    const notes: string[] = []

    await ops.gitAddWorktree(path, `wt/${name}`, baseRef)
    let neon: { id: string; databaseUrl: string } | undefined
    try {
      neon = await ops.neonCreateBranch(`wt/${name}`)
      await ops.writeWorktreeEnv(path, {
        DATABASE_URL: neon.databaseUrl,
        NEON_BRANCH: `wt/${name}`,
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

    if (phone) await releasePhone(phone, name, notes)
    const meta: ops.Meta = {
      name, path, gitBranch: `wt/${name}`, port, phone: phone ?? null,
      neonBranchId: neon.id, neonBranchName: `wt/${name}`, createdAt: new Date().toISOString(),
    }
    await ops.writeMeta(meta)
    if (start) {
      const url = await ops.startProcesses(name, path, port).catch((err: Error) => {
        notes.push(`Created, but starting failed: ${err.message}`)
        return null
      })
      await routeTo(meta, url, notes)
    }
    return { worktree: await describeOne(name), notes }
  }),
)

extension.tool(removeWorktree, (_context, { name, force }) =>
  serial(async () => {
    const meta = await find(name)
    const notes: string[] = []
    const git = await ops.gitState(meta.path)
    if (git.dirtyFiles && !force) {
      throw new ops.DomainError(`"${name}" has ${git.dirtyFiles} uncommitted file(s). Commit them, or remove with force.`)
    }
    await ops.stopUnits(name)
    await unroute(meta, notes)
    await ops.neonDeleteBranch(meta.neonBranchId)
    await ops.gitRemoveWorktree(meta.path)
    notes.push(`Kept git branch ${meta.gitBranch}${git.aheadOfMain ? ` (${git.aheadOfMain} commit(s) ahead of main)` : ''}.`)
    return { removed: name, notes }
  }),
)

extension.tool(setPhone, (_context, { name, phone }) =>
  serial(async () => {
    const meta = await find(name)
    const notes: string[] = []
    if (meta.phone && meta.phone !== phone) await unroute(meta, notes)
    if (phone) await releasePhone(phone, name, notes)
    const updated = { ...meta, phone }
    await ops.writeMeta(updated)
    await ops.writeWorktreeEnv(meta.path, { DEV_PHONE: phone ?? '', WHATSAPP_ALLOWLIST: phone ?? '' })
    const state = await ops.processState(name, meta.path, meta.port)
    let url = state.publicUrl
    if (state.app !== 'stopped') {
      // The allowlist is read at startup.
      url = await ops.startProcesses(name, meta.path, meta.port).catch((err: Error) => {
        notes.push(`Restart failed: ${err.message}`)
        return null
      })
    }
    await routeTo(updated, url, notes)
    return { worktree: await describeOne(name), notes }
  }),
)

extension.tool(startWorktree, (_context, { name }) =>
  serial(async () => {
    const meta = await find(name)
    const notes: string[] = []
    const url = await ops.startProcesses(name, meta.path, meta.port)
    await routeTo(meta, url, notes)
    return { worktree: await describeOne(name), notes }
  }),
)

extension.tool(stopWorktree, (_context, { name }) =>
  serial(async () => {
    const meta = await find(name)
    const notes: string[] = []
    await ops.stopUnits(name)
    await unroute(meta, notes)
    return { worktree: await describeOne(name), notes }
  }),
)

// Chat tools aren't serialised: a turn takes a while and doesn't touch worktree state.
extension.tool(chatSend, async (_context, { name, phone, text, profileName, timeoutSeconds, quietSeconds }) => {
  const app = await App.open(await find(name))
  const { messages, timedOut, onboardingStatus } = await app.chat(phone, text, {
    profileName,
    deadline: Date.now() + timeoutSeconds * 1000,
    quietMs: quietSeconds * 1000,
  })
  return { phone, replies: messages, timedOut, onboardingStatus }
})

extension.tool(chatMessages, async (_context, { name, phone, since, limit }) => {
  const app = await App.open(await find(name))
  const { messages, onboardingStatus } = await app.outbox(phone, since, limit)
  return { phone, messages, onboardingStatus }
})

extension.tool(chatOnboard, async (_context, input) => onboard(await App.open(await find(input.name)), input))

extension.tool(chatReset, async (_context, { name, phone, force }) => (await App.open(await find(name))).reset(phone, force))

extension.app(appDocument)
extension.tool(openWorktreesApp, () => ({ ready: true }))

process.on('exit', () => void ops.closeProd())
await extension.listen()
