import { appResource, defineExtension, resource, tool, z } from '@atmos.build/extension'

export const WorktreeName = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,29}$/, 'lowercase letters, digits and dashes, at most 30 characters')
export const Phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'an E.164 number without spaces, such as +4915112345678')

export const RouteState = z.object({
  status: z.enum(['active', 'expired', 'none', 'elsewhere', 'unknown']),
  expiresAt: z.string().nullable(),
  message: z.string().nullable(),
})

export const Worktree = z.object({
  name: z.string(),
  path: z.string(),
  gitBranch: z.string(),
  port: z.number().int(),
  phone: z.string().nullable(),
  neonBranchId: z.string(),
  neonBranchName: z.string(),
  createdAt: z.string(),
  app: z.enum(['running', 'starting', 'stopped', 'failed']),
  publicUrl: z.string().nullable(),
  route: RouteState,
  dirtyFiles: z.number().int(),
  aheadOfMain: z.number().int(),
  lastCommit: z.string(),
})

export const WorktreeList = z.object({
  repo: z.string(),
  worktrees: z.array(Worktree),
})

export const worktreeList = resource({
  uri: 'atmos://worktrees/list',
  name: 'Booking agent worktrees',
  schema: WorktreeList,
})

export const listWorktrees = tool({
  name: 'list_worktrees',
  title: 'List worktrees',
  description:
    'List the booking-agent dev worktrees on this Machine with their port, public URL, Neon branch, routed WhatsApp phone and git state.',
  input: z.object({}),
  output: WorktreeList,
  annotations: { readOnlyHint: true, destructiveHint: false },
  text: ({ worktrees }) =>
    worktrees.length
      ? worktrees.map((w) => `${w.name}: ${w.app} on :${w.port} ${w.publicUrl ?? ''} phone ${w.phone ?? '—'} (${w.route.status})`).join('\n')
      : 'No worktrees yet.',
})

export const createWorktree = tool({
  name: 'create_worktree',
  title: 'Create worktree',
  description:
    'Create a git worktree on branch wt/<name>, branch the production Neon database for it, write its .env from the main checkout, start its dev server and tunnel, and route the phone (optional) to it.',
  input: z.object({
    name: WorktreeName,
    phone: Phone.optional().describe('WhatsApp number whose inbound messages go to this worktree; also its only outbound allowlist entry'),
    baseRef: z.string().trim().min(1).max(100).default('main').describe('Git ref the new branch starts from'),
    start: z.boolean().default(true).describe('Start the dev server and tunnel right away'),
  }),
  output: z.object({ worktree: Worktree, notes: z.array(z.string()) }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  text: ({ worktree, notes }) =>
    [`Created ${worktree.name} at ${worktree.path} (:${worktree.port}, ${worktree.publicUrl ?? 'no tunnel'}).`, ...notes].join('\n'),
})

export const removeWorktree = tool({
  name: 'remove_worktree',
  title: 'Remove worktree',
  description:
    'Stop a worktree, drop its WhatsApp route, delete its Neon branch and remove the git worktree. Refuses when there are uncommitted changes unless force is set. The git branch is kept.',
  input: z.object({ name: WorktreeName, force: z.boolean().default(false) }),
  output: z.object({ removed: z.string(), notes: z.array(z.string()) }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  text: ({ removed, notes }) => [`Removed ${removed}.`, ...notes].join('\n'),
})

export const setPhone = tool({
  name: 'set_worktree_phone',
  title: 'Set worktree phone',
  description:
    "Set (or clear with null) the WhatsApp number routed to a worktree. Updates the worktree's allowlist, restarts its app and points production's route for that number at it; a number routed elsewhere moves here.",
  input: z.object({ name: WorktreeName, phone: Phone.nullable() }),
  output: z.object({ worktree: Worktree, notes: z.array(z.string()) }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  text: ({ worktree, notes }) => [`${worktree.name} now uses ${worktree.phone ?? 'no phone'} (${worktree.route.status}).`, ...notes].join('\n'),
})

export const startWorktree = tool({
  name: 'start_worktree',
  title: 'Start worktree',
  description: "Start a worktree's tunnel and dev server, refresh PUBLIC_URL and renew its WhatsApp route.",
  input: z.object({ name: WorktreeName }),
  output: z.object({ worktree: Worktree, notes: z.array(z.string()) }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  text: ({ worktree, notes }) => [`${worktree.name} is ${worktree.app} at ${worktree.publicUrl ?? 'no URL'}.`, ...notes].join('\n'),
})

export const stopWorktree = tool({
  name: 'stop_worktree',
  title: 'Stop worktree',
  description: "Stop a worktree's dev server and tunnel and drop its WhatsApp route, so its phone goes back to production.",
  input: z.object({ name: WorktreeName }),
  output: z.object({ worktree: Worktree, notes: z.array(z.string()) }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  text: ({ worktree }) => `${worktree.name} stopped.`,
})

export const appDocument = appResource({
  uri: 'ui://worktrees/app.html',
  name: 'Worktrees',
})

export const openWorktreesApp = tool({
  name: 'open_worktrees',
  title: 'Worktrees',
  description: 'Open the Worktrees app to see, create, start, stop and remove booking-agent dev worktrees and change their phone.',
  input: z.object({}),
  output: z.object({ ready: z.boolean() }),
  annotations: { readOnlyHint: true, destructiveHint: false },
  app: {
    document: appDocument,
    icon: 'workflow',
    resources: [worktreeList],
  },
  text: () => 'Worktrees is open.',
})

export const extensionContract = defineExtension({
  name: 'worktrees',
  version: '0.1.0',
  resources: { worktreeList, appDocument },
  tools: { listWorktrees, createWorktree, removeWorktree, setPhone, startWorktree, stopWorktree, openWorktreesApp },
})

export type Worktree = z.infer<typeof Worktree>
export type RouteState = z.infer<typeof RouteState>
