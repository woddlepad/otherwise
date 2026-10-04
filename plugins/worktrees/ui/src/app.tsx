import { useEffect, useState, type FormEvent } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Label,
  Skeleton,
  StatusBadge,
} from '@atmos.build/ui'
import { useAtmosMcpApp, useMcpResource, useMcpTool, type App } from '@atmos.build/ui/mcp-app'

import {
  createWorktree,
  removeWorktree,
  setPhone,
  startWorktree,
  stopWorktree,
  worktreeList,
  type Worktree,
} from '../../server/contract'

const t = {
  title: 'Worktrees',
  subtitle: 'Dev copies of the booking agent on this Machine. Each one has its own Neon branch, port and tunnel.',
  newWorktree: 'New worktree',
  name: 'Name',
  namePlaceholder: 'onboarding-fix',
  phone: 'WhatsApp phone',
  phoneHint: 'Optional. Inbound messages from this number go to the worktree, and it may only message this number.',
  baseRef: 'Start from',
  create: 'Create',
  creating: 'Creating… branching Neon and starting the tunnel, about 30s',
  cancel: 'Cancel',
  emptyTitle: 'No worktrees yet',
  emptyBody: 'Create one to work on a branch with its own database and WhatsApp route.',
  loadFailed: 'Could not load worktrees',
  retry: 'Retry',
  start: 'Start',
  restart: 'Restart',
  stop: 'Stop',
  remove: 'Remove',
  change: 'Change',
  save: 'Save',
  clear: 'Clear',
  noPhone: 'No phone',
  removeTitle: (n: string) => `Remove ${n}?`,
  removeBody: 'Stops it, drops its WhatsApp route and deletes its Neon branch and folder. The git branch is kept.',
  dirty: (n: number) => `${n} uncommitted file${n === 1 ? '' : 's'} will be lost`,
  forceLabel: 'Remove anyway',
  app: { running: 'Running', starting: 'Starting', stopped: 'Stopped', failed: 'Failed' },
  route: {
    active: 'WhatsApp routed',
    expired: 'Route expired',
    none: 'Not routed',
    elsewhere: 'Routed elsewhere',
    unknown: 'Route unknown',
  },
}

const appTone = { running: 'success', starting: 'info', stopped: 'neutral', failed: 'danger' } as const
const routeTone = { active: 'success', expired: 'warning', none: 'neutral', elsewhere: 'warning', unknown: 'warning' } as const

type Notice = { tone: 'ok' | 'error'; lines: string[] }

export function WorktreesApp() {
  const { app, isConnected } = useAtmosMcpApp({ name: 'worktrees', version: '0.1.0' })
  const list = useMcpResource(app, worktreeList)
  const [showCreate, setShowCreate] = useState(false)
  const [notice, setNotice] = useState<Notice>()

  // Poll while something is booting, so "Starting" turns into "Running" on its own.
  const booting = list.data?.worktrees.some((w) => w.app === 'starting')
  useEffect(() => {
    if (!booting) return
    const id = setInterval(list.refresh, 4000)
    return () => clearInterval(id)
  }, [booting, list.refresh])

  const report = (lines: string[], tone: Notice['tone'] = 'ok') => {
    setNotice({ tone, lines })
    list.refresh()
  }
  const fail = (err: unknown) => report([err instanceof Error ? err.message : String(err)], 'error')

  if (!isConnected) return <Skeleton className="m-6 h-32" />

  const worktrees = list.data?.worktrees ?? []
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-medium">{t.title}</h1>
          <p className="text-muted-foreground text-sm">{t.subtitle}</p>
        </div>
        {!showCreate && worktrees.length > 0 && <Button onClick={() => setShowCreate(true)}>{t.newWorktree}</Button>}
      </header>

      <div role="status" aria-live="polite">
        {notice && (
          <div
            className={`rounded-md border px-3 py-2 text-sm ${notice.tone === 'error' ? 'border-destructive/40 text-destructive' : 'border-border'}`}
          >
            {notice.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateForm
          app={app}
          onCancel={() => setShowCreate(false)}
          onDone={(lines) => {
            setShowCreate(false)
            report(lines)
          }}
          onError={fail}
        />
      )}

      {list.loading && !list.data ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : list.error && !list.data ? (
        <EmptyState
          tone="attention"
          title={t.loadFailed}
          description={list.error.message}
          action={<Button variant="outline" onClick={list.refresh}>{t.retry}</Button>}
        />
      ) : worktrees.length === 0 ? (
        !showCreate && (
          <EmptyState
            title={t.emptyTitle}
            description={t.emptyBody}
            action={<Button onClick={() => setShowCreate(true)}>{t.newWorktree}</Button>}
          />
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {worktrees.map((w) => (
            <WorktreeCard key={w.name} app={app} worktree={w} onDone={report} onError={fail} />
          ))}
        </ul>
      )}
    </main>
  )
}

function CreateForm(props: { app: App | null; onCancel: () => void; onDone: (lines: string[]) => void; onError: (e: unknown) => void }) {
  const create = useMcpTool(props.app, createWorktree)
  const [name, setName] = useState('')
  const [phone, setPhoneValue] = useState('')
  const [baseRef, setBaseRef] = useState('main')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const r = await create.call({ name: name.trim(), phone: phone.trim() || undefined, baseRef: baseRef.trim() || 'main', start: true })
      props.onDone([`Created ${r.worktree.name} on :${r.worktree.port}.`, ...r.notes])
    } catch (err) {
      props.onError(err)
    }
  }

  return (
    <form onSubmit={submit} className="border-border flex flex-col gap-3 rounded-lg border p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wt-name">{t.name}</Label>
          <Input
            id="wt-name"
            required
            autoFocus
            pattern="[a-z0-9][a-z0-9-]{0,29}"
            placeholder={t.namePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wt-phone">{t.phone}</Label>
          <Input id="wt-phone" type="tel" pattern="\+[1-9][0-9]{6,14}" placeholder="+4915112345678" value={phone} onChange={(e) => setPhoneValue(e.target.value.replace(/\s/g, ''))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wt-base">{t.baseRef}</Label>
          <Input id="wt-base" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t.phoneHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={create.loading || !name}>
          {t.create}
        </Button>
        <Button type="button" variant="ghost" onClick={props.onCancel} disabled={create.loading}>
          {t.cancel}
        </Button>
        {create.loading && <span className="text-muted-foreground text-sm">{t.creating}</span>}
      </div>
    </form>
  )
}

function WorktreeCard(props: { app: App | null; worktree: Worktree; onDone: (lines: string[]) => void; onError: (e: unknown) => void }) {
  const w = props.worktree
  const start = useMcpTool(props.app, startWorktree)
  const stop = useMcpTool(props.app, stopWorktree)
  const remove = useMcpTool(props.app, removeWorktree)
  const phone = useMcpTool(props.app, setPhone)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(w.phone ?? '')
  const [force, setForce] = useState(false)
  const busy = start.loading || stop.loading || remove.loading || phone.loading

  const act = async (fn: () => Promise<{ notes: string[] }>, done: string) => {
    try {
      const r = await fn()
      props.onDone([done, ...r.notes])
    } catch (err) {
      props.onError(err)
    }
  }
  const savePhone = async (value: string | null) => {
    await act(() => phone.call({ name: w.name, phone: value }), value ? `${w.name} now uses ${value}.` : `${w.name} has no phone.`)
    setEditing(false)
  }
  const open = (url: string) => {
    void props.app?.openLink({ url }).catch(() => {})
  }

  return (
    <li className="border-border flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate font-medium">{w.name}</h2>
          <StatusBadge size="sm" tone={appTone[w.app]} label={t.app[w.app]} busy={w.app === 'starting'} />
          {w.phone && <StatusBadge size="sm" tone={routeTone[w.route.status]} label={t.route[w.route.status]} title={w.route.message ?? undefined} />}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => start.call({ name: w.name }), `${w.name} started.`)}>
            {w.app === 'stopped' ? t.start : t.restart}
          </Button>
          {w.app !== 'stopped' && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => stop.call({ name: w.name }), `${w.name} stopped.`)}>
              {t.stop}
            </Button>
          )}
          <AlertDialog onOpenChange={() => setForce(false)}>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="ghost" disabled={busy}>
                {t.remove}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t.removeTitle(w.name)}</AlertDialogTitle>
                <AlertDialogDescription>{t.removeBody}</AlertDialogDescription>
              </AlertDialogHeader>
              {w.dirtyFiles > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox id={`force-${w.name}`} checked={force} onCheckedChange={(v) => setForce(v === true)} />
                  <Label htmlFor={`force-${w.name}`}>
                    {t.forceLabel}: {t.dirty(w.dirtyFiles)}
                  </Label>
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={w.dirtyFiles > 0 && !force}
                  onClick={() => act(async () => remove.call({ name: w.name, force }), `Removed ${w.name}.`)}
                >
                  {t.remove}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>URL</dt>
        <dd className="min-w-0 truncate">
          {w.publicUrl ? (
            <a className="text-foreground underline underline-offset-2" href={w.publicUrl} onClick={(e) => (e.preventDefault(), open(w.publicUrl!))}>
              {w.publicUrl.replace('https://', '')}
            </a>
          ) : (
            '—'
          )}{' '}
          · :{w.port}
        </dd>
        <dt>Branch</dt>
        <dd className="min-w-0 truncate">
          {w.gitBranch} · {w.aheadOfMain} ahead · {w.dirtyFiles} changed
          <span className="block truncate text-xs">{w.lastCommit}</span>
        </dd>
        <dt>Database</dt>
        <dd className="min-w-0 truncate">Neon {w.neonBranchName}</dd>
        <dt>Phone</dt>
        <dd className="min-w-0">
          {editing ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void savePhone(draft.trim() || null)
              }}
            >
              <Input
                aria-label={t.phone}
                autoFocus
                type="tel"
                pattern="\+[1-9][0-9]{6,14}"
                className="h-8 w-44"
                value={draft}
                onChange={(e) => setDraft(e.target.value.replace(/\s/g, ''))}
              />
              <Button size="sm" type="submit" disabled={busy}>
                {t.save}
              </Button>
              {w.phone && (
                <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => void savePhone(null)}>
                  {t.clear}
                </Button>
              )}
              <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                {t.cancel}
              </Button>
            </form>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-foreground">{w.phone ?? t.noPhone}</span>
              {w.route.expiresAt && w.route.status === 'active' && (
                <span className="text-xs">until {new Date(w.route.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              )}
              {w.route.message && <span className="text-xs">({w.route.message})</span>}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(w.phone ?? '')
                  setEditing(true)
                }}
              >
                {t.change}
              </Button>
            </span>
          )}
        </dd>
      </dl>
    </li>
  )
}
