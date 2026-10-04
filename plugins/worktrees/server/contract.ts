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

// ---------- chat: talk to a worktree's agent through its real WhatsApp webhook ----------

const testPhones =
  'Use +1555 test numbers (e.g. +15550100001): they are never in a worktree\'s allowlist, so nothing reaches Twilio or a real person.'

export const ChatMessage = z.object({
  id: z.string(),
  at: z.string().describe('When the app sent it (database clock, ISO)'),
  body: z.string(),
  mediaUrl: z.string().nullable(),
  status: z.string().describe('sent | dry_run | not_allowlisted | failed'),
  error: z.string().nullable(),
})

const OnboardingStatus = z.string().nullable().describe('new | link_sent | analyzing | ready; null when the user does not exist')

export const chatSend = tool({
  name: 'chat_send',
  title: 'Send a test WhatsApp message',
  description:
    "Send a WhatsApp message to a worktree's agent as a user would: the message enters the app's real /webhooks/whatsapp " +
    'route signed like a message production forwards to a worktree, and the replies are read back from the outbox of the ' +
    'real outbound path. Returns once something arrived and nothing new came for quietSeconds, or on timeout. ' +
    'A user who is not onboarded gets the setup link (see chat_onboard). Turns that search for events can take 2-3 minutes: ' +
    'raise timeoutSeconds, or pick up late replies with chat_messages. ' + testPhones,
  input: z.object({
    name: WorktreeName,
    phone: Phone,
    text: z.string().min(1).max(4000),
    profileName: z.string().trim().min(1).max(100).optional().describe('WhatsApp profile name; becomes the user\'s name on first contact'),
    timeoutSeconds: z.number().int().min(5).max(600).default(90),
    quietSeconds: z.number().min(1).max(60).default(5).describe('How long without new messages counts as the turn being over'),
  }),
  output: z.object({ phone: z.string(), replies: z.array(ChatMessage), timedOut: z.boolean(), onboardingStatus: OnboardingStatus }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  text: ({ replies, timedOut }) =>
    [...replies.map((m) => `← ${m.body}${m.mediaUrl ? ` [media ${m.mediaUrl}]` : ''}`), ...(timedOut ? [replies.length ? '(timed out waiting for more)' : '(no reply before the timeout; see .atmos/app.log)'] : [])].join('\n\n'),
})

export const chatMessages = tool({
  name: 'chat_messages',
  title: 'Read test WhatsApp messages',
  description:
    "Messages a worktree's app sent to a phone, oldest first, from its outbox: late replies and proactive messages " +
    '(picks, booking updates, the onboarding "Ready" message). Without since, the latest limit messages.',
  input: z.object({
    name: WorktreeName,
    phone: Phone,
    since: z.string().datetime({ offset: true }).optional().describe('Only messages after this ISO time'),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  output: z.object({ phone: z.string(), messages: z.array(ChatMessage), onboardingStatus: OnboardingStatus }),
  annotations: { readOnlyHint: true, destructiveHint: false },
  text: ({ messages }) => (messages.length ? messages.map((m) => `${m.at} [${m.status}] ${m.body}`).join('\n\n') : 'No messages.'),
})

export const chatOnboard = tool({
  name: 'chat_onboard',
  title: 'Onboard a test user',
  description:
    'Sign a test user up through the real onboarding flow: sends a first WhatsApp message (as chat_send), takes the setup ' +
    'link from the reply, submits the real setup form with city, interests and budget without connecting mail or calendar ' +
    '(those buttons are optional), then waits for the onboard-user workflow\'s "Ready to go" WhatsApp message. Fails naming ' +
    'the step that broke. An already-onboarded phone fails at the first step: run chat_reset first. ' + testPhones,
  input: z.object({
    name: WorktreeName,
    phone: Phone,
    profileName: z.string().trim().min(1).max(100).optional(),
    firstMessage: z.string().min(1).max(500).default('Hi'),
    city: z.string().trim().min(1).max(100),
    interests: z.array(z.string().trim().min(1).max(100)).max(20).describe('What the user tells us they like'),
    monthlyBudgetEur: z.number().min(0).max(10_000),
    autoApproveEur: z.number().min(0).max(10_000).describe('Book unasked up to this price'),
    timezone: z.string().trim().max(60).optional().describe('IANA zone the browser would send, e.g. Europe/Berlin'),
    timeoutSeconds: z.number().int().min(10).max(900).default(180),
  }),
  output: z.object({
    phone: z.string(),
    steps: z.array(z.object({ step: z.string(), ok: z.boolean(), detail: z.string() })),
    messages: z.array(ChatMessage),
    onboardingStatus: OnboardingStatus,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  text: ({ steps, messages, onboardingStatus }) =>
    [...steps.map((s) => `✓ ${s.step}: ${s.detail}`), `Status: ${onboardingStatus}`, '', ...messages.map((m) => `← ${m.body}`)].join('\n'),
})

export const chatReset = tool({
  name: 'chat_reset',
  title: 'Reset a test user',
  description:
    "Delete a phone's user from a worktree's database (budget, taste profile, bookings, credits, ... cascade), its outbox " +
    'and its chat memory, so the next message starts from scratch. Refuses numbers outside +1555 unless force: worktree ' +
    'databases are copies of production with real users.',
  input: z.object({ name: WorktreeName, phone: Phone, force: z.boolean().default(false) }),
  output: z.object({ phone: z.string(), deletedUserId: z.string().nullable(), outboxDeleted: z.number().int(), threadDeleted: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  text: ({ phone, deletedUserId, outboxDeleted, threadDeleted }) =>
    deletedUserId || outboxDeleted || threadDeleted
      ? `Reset ${phone}: ${deletedUserId ? 'user deleted' : 'no user'}, ${outboxDeleted} outbox message(s), ${threadDeleted ? 'chat memory cleared' : 'no chat memory'}.`
      : `${phone} had nothing to reset.`,
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
  tools: {
    listWorktrees, createWorktree, removeWorktree, setPhone, startWorktree, stopWorktree, openWorktreesApp,
    chatSend, chatMessages, chatOnboard, chatReset,
  },
})

export type Worktree = z.infer<typeof Worktree>
export type RouteState = z.infer<typeof RouteState>
export type ChatMessage = z.infer<typeof ChatMessage>
