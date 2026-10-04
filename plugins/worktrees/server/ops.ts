import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import pg from 'pg'

import type { RouteState } from './contract.ts'

const run = promisify(execFile)

const uid = process.getuid?.() ?? 1000
export const config = {
  repo: process.env.BOOKING_REPO || '/home/atmos/booking-agent',
  get worktreesDir() {
    return process.env.WORKTREES_DIR || `${this.repo}-worktrees`
  },
  neonProject: process.env.NEON_PROJECT_ID || 'withered-thunder-13037252',
  neonParent: process.env.NEON_PARENT_BRANCH || 'production',
  basePort: Number(process.env.WORKTREES_BASE_PORT || 4112),
  routeTtlHours: Number(process.env.WORKTREES_ROUTE_TTL_HOURS || 12),
  branchTtlDays: Number(process.env.WORKTREES_BRANCH_TTL_DAYS || 14),
}

const env = {
  ...process.env,
  PATH: [`${process.env.HOME}/.npm-global/bin`, '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH].join(':'),
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
}

export class DomainError extends Error {}

async function sh(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  try {
    const { stdout } = await run(cmd, args, { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- git ----------

export async function gitAddWorktree(path: string, branch: string, baseRef: string) {
  const exists = await sh('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: config.repo }).then(
    () => true,
    () => false,
  )
  await sh('git', exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseRef], { cwd: config.repo })
}

export async function gitRemoveWorktree(path: string) {
  if (!existsSync(path)) {
    await sh('git', ['worktree', 'prune'], { cwd: config.repo })
    return
  }
  await sh('git', ['worktree', 'remove', '--force', path], { cwd: config.repo })
}

export async function gitState(path: string) {
  if (!existsSync(path)) return { dirtyFiles: 0, aheadOfMain: 0, lastCommit: '(missing)' }
  const [status, ahead, last] = await Promise.all([
    sh('git', ['status', '--porcelain'], { cwd: path }).catch(() => ''),
    sh('git', ['rev-list', '--count', 'main..HEAD'], { cwd: path }).catch(() => '0'),
    sh('git', ['log', '-1', '--format=%h %s'], { cwd: path }).catch(() => ''),
  ])
  return { dirtyFiles: status ? status.split('\n').length : 0, aheadOfMain: Number(ahead) || 0, lastCommit: last }
}

export async function linkNodeModules(path: string) {
  // Hard-link copy: seconds instead of an npm install, and npm replaces (never edits) files, so the main checkout is safe.
  const from = join(config.repo, 'node_modules')
  if (existsSync(from) && !existsSync(join(path, 'node_modules'))) await sh('cp', ['-al', from, join(path, 'node_modules')], { timeoutMs: 120_000 })
}

export async function migrate(path: string) {
  await sh(join(path, 'node_modules/.bin/tsx'), ['scripts/migrate.ts'], { cwd: path, timeoutMs: 60_000 })
}

// ---------- env ----------

/** Copy of `base` with keys set (string) or removed (null); comments and order are kept. */
export function renderEnv(base: string, overrides: Record<string, string | null>) {
  const seen = new Set<string>()
  const lines = base.split('\n').flatMap((line) => {
    const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1]
    if (!key || !(key in overrides)) return [line]
    seen.add(key)
    const value = overrides[key]
    return value === null ? [] : [`${key}=${value}`]
  })
  const added = Object.entries(overrides).filter(([k, v]) => !seen.has(k) && v !== null)
  if (added.length) lines.push('', '# --- worktree (written by plugins/worktrees) ---', ...added.map(([k, v]) => `${k}=${v}`))
  return lines.join('\n').replace(/\n*$/, '\n')
}

export async function writeWorktreeEnv(path: string, overrides: Record<string, string | null>, fromMain = false) {
  const source = fromMain ? join(config.repo, '.env') : join(path, '.env')
  const base = await readFile(source, 'utf8').catch(() => '')
  await writeFile(join(path, '.env'), renderEnv(base, overrides), { mode: 0o600 })
}

// ---------- neon ----------

export async function neonCreateBranch(name: string) {
  const expiresAt = new Date(Date.now() + config.branchTtlDays * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const out = await sh('neon', [
    'branches', 'create', '--project-id', config.neonProject, '--name', name, '--parent', config.neonParent,
    '--expires-at', expiresAt, '--output', 'json',
  ], { timeoutMs: 90_000 })
  const id = (JSON.parse(out) as { branch?: { id?: string } }).branch?.id
  if (!id) throw new Error('neon branches create returned no branch id')
  return { id, databaseUrl: await neonConnectionString(id) }
}

export function neonConnectionString(branch: string) {
  return sh('neon', ['connection-string', branch, '--project-id', config.neonProject, '--pooled'])
}

export async function neonDeleteBranch(id: string) {
  await sh('neon', ['branches', 'delete', id, '--project-id', config.neonProject]).catch((err: Error) => {
    if (!/not found|404/i.test(err.message)) throw err
  })
}

// ---------- processes (transient systemd --user units) ----------

const unit = (name: string, kind: 'app' | 'tunnel') => `wt-${name}-${kind}`
const atmosDir = (path: string) => join(path, '.atmos')

async function unitState(u: string) {
  return sh('systemctl', ['--user', 'is-active', u]).catch((err: Error) => (/failed/.test(err.message) ? 'failed' : 'inactive'))
}

async function startUnit(u: string, cwd: string, log: string, cmd: string[], extra: string[] = []) {
  await sh('systemctl', ['--user', 'stop', u]).catch(() => {})
  await sh('systemctl', ['--user', 'reset-failed', u]).catch(() => {})
  await sh('systemd-run', [
    '--user', `--unit=${u}`, `--working-directory=${cwd}`, `-p`, `StandardOutput=truncate:${log}`, `-p`, `StandardError=inherit`,
    `--setenv=PATH=${env.PATH}`, ...extra, ...cmd,
  ])
}

export async function stopUnits(name: string) {
  for (const kind of ['app', 'tunnel'] as const) {
    await sh('systemctl', ['--user', 'stop', unit(name, kind)]).catch(() => {})
    await sh('systemctl', ['--user', 'reset-failed', unit(name, kind)]).catch(() => {})
  }
}

async function tunnelUrl(path: string) {
  const log = await readFile(join(atmosDir(path), 'tunnel.log'), 'utf8').catch(() => '')
  return log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)?.at(-1) ?? null
}

/** Tunnel first (its URL goes into PUBLIC_URL), then the dev server, which reads .env on start. */
export async function startProcesses(name: string, path: string, port: number) {
  await mkdir(atmosDir(path), { recursive: true })
  await startUnit(unit(name, 'tunnel'), path, join(atmosDir(path), 'tunnel.log'), [
    '/usr/local/bin/cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`,
  ])
  let url: string | null = null
  for (let i = 0; i < 40 && !url; i++) {
    await sleep(500)
    url = await tunnelUrl(path)
  }
  if (!url) throw new Error('cloudflared did not print a tunnel URL within 20s (see .atmos/tunnel.log)')
  await writeWorktreeEnv(path, { PUBLIC_URL: url })
  await startUnit(unit(name, 'app'), path, join(atmosDir(path), 'app.log'), ['/usr/bin/npx', 'mastra', 'dev'], [
    `--setenv=PORT=${port}`, '-p', 'Restart=on-failure', '-p', 'RestartSec=3',
  ])
  return url
}

export async function processState(name: string, path: string, port: number) {
  const [app, tunnel] = await Promise.all([unitState(unit(name, 'app')), unitState(unit(name, 'tunnel'))])
  const publicUrl = tunnel === 'active' ? await tunnelUrl(path) : null
  if (app === 'failed') return { app: 'failed' as const, publicUrl }
  if (app !== 'active' && app !== 'activating') return { app: 'stopped' as const, publicUrl }
  const healthy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }).then(
    (r) => r.ok,
    () => false,
  )
  return { app: healthy ? ('running' as const) : ('starting' as const), publicUrl }
}

// ---------- production WhatsApp routes (dev_routes in the prod DB) ----------

let prod: pg.Pool | undefined
async function prodDb() {
  prod ??= new pg.Pool({ connectionString: await neonConnectionString(config.neonParent), max: 2, idleTimeoutMillis: 10_000 })
  return prod
}

export async function upsertRoute(phone: string, worktree: string, targetUrl: string) {
  await (await prodDb()).query(
    `INSERT INTO dev_routes (phone, worktree, target_url, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))
     ON CONFLICT (phone) DO UPDATE SET worktree = EXCLUDED.worktree, target_url = EXCLUDED.target_url,
       expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [phone, worktree, targetUrl, config.routeTtlHours],
  )
}

export async function deleteRoute(phone: string, worktree: string) {
  await (await prodDb()).query(`DELETE FROM dev_routes WHERE phone = $1 AND worktree = $2`, [phone, worktree])
}

/** Route state per phone; 'unknown' with the reason when prod can't be read. */
export async function routeStates(entries: { phone: string | null; name: string; publicUrl: string | null }[]) {
  const states = new Map<string, RouteState>()
  const phones = entries.flatMap((e) => (e.phone ? [e.phone] : []))
  let rows: { phone: string; worktree: string; target_url: string; expires_at: Date; live: boolean }[] = []
  let error: string | null = null
  if (phones.length) {
    try {
      rows = (await (await prodDb()).query(
        `SELECT phone, worktree, target_url, expires_at, expires_at > now() AS live FROM dev_routes WHERE phone = ANY($1)`,
        [phones],
      )).rows
    } catch (err) {
      error = String((err as Error).message)
    }
  }
  for (const e of entries) {
    const r = rows.find((row) => row.phone === e.phone)
    const state: RouteState = !e.phone
      ? { status: 'none', expiresAt: null, message: null }
      : error
        ? { status: 'unknown', expiresAt: null, message: error }
        : !r
          ? { status: 'none', expiresAt: null, message: null }
          : r.worktree !== e.name
            ? { status: 'elsewhere', expiresAt: r.expires_at.toISOString(), message: `routed to ${r.worktree}` }
            : { status: r.live ? 'active' : 'expired', expiresAt: r.expires_at.toISOString(),
                message: e.publicUrl && r.target_url !== e.publicUrl ? 'route points at an old tunnel URL; start again' : null }
    states.set(e.name, state)
  }
  return states
}

export async function closeProd() {
  await prod?.end().catch(() => {})
}
