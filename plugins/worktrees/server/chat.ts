import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ChatMessage } from './contract.ts'
import { DomainError, type Meta } from './ops.ts'

// Test chats go through the worktree's real WhatsApp webhook, signed the way production signs a forwarded
// message (src/lib/devroutes.ts), and replies are read back from the app's outbox (outbound_messages, via
// GET /dev/outbox). +1555 numbers are never in a worktree's allowlist, so nothing reaches Twilio.

const POLL_MS = 1000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Outbox = { now: string; onboardingStatus: string | null; messages: ChatMessage[] }

/** `KEY=value` lines of a dotenv file; quotes around values are dropped. */
export function parseEnv(text: string) {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** HTTP access to one worktree's running app, with the secrets from its .env. */
export class App {
  readonly base: string
  private constructor(private meta: Meta, private env: Record<string, string>) {
    this.base = `http://127.0.0.1:${meta.port}`
  }

  static async open(meta: Meta) {
    const env = parseEnv(await readFile(join(meta.path, '.env'), 'utf8').catch(() => ''))
    if (!env.DEV_FORWARD_SECRET) throw new DomainError(`${meta.name}/.env has no DEV_FORWARD_SECRET, so its webhook can't be signed.`)
    return new App(meta, env)
  }

  private async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    if (this.env.DEV_CHAT_TOKEN) headers.set('X-Dev-Token', this.env.DEV_CHAT_TOKEN)
    try {
      return await fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000), redirect: 'manual' })
    } catch (err) {
      throw new DomainError(`${this.meta.name} is not answering on :${this.meta.port} (${(err as Error).message}). Is it running? Try start_worktree.`)
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init)
    const text = await res.text()
    if (!res.ok) {
      const hint = res.status === 404 && path.startsWith('/dev/') ? ' (does this worktree have the chat dev routes? merge main / restart it)' : ''
      throw new DomainError(`${path.split('?')[0]} answered ${res.status}: ${text.slice(0, 300)}${hint}`)
    }
    return JSON.parse(text) as T
  }

  outbox(phone: string, since?: string, limit?: number) {
    const q = new URLSearchParams({ phone })
    if (since) q.set('since', since)
    if (limit) q.set('limit', String(limit))
    return this.json<Outbox>(`/dev/outbox?${q}`)
  }

  reset(phone: string, force: boolean) {
    return this.json<{ phone: string; deletedUserId: string | null; outboxDeleted: number; threadDeleted: boolean }>('/dev/reset-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, force }),
    })
  }

  /** POSTs a Twilio-shaped inbound message to /webhooks/whatsapp, signed like production's forward. */
  async sendInbound(phone: string, text: string, profileName?: string) {
    const sid = `SMtest${randomBytes(13).toString('hex')}`
    const form = new URLSearchParams({
      SmsMessageSid: sid,
      NumMedia: '0',
      SmsSid: sid,
      SmsStatus: 'received',
      Body: text,
      To: this.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
      NumSegments: '1',
      MessageSid: sid,
      AccountSid: this.env.TWILIO_ACCOUNT_SID || 'ACtest',
      From: `whatsapp:${phone}`,
      ApiVersion: '2010-04-01',
      WaId: phone.replace(/^\+/, ''),
      MessageType: 'text',
      ...(profileName ? { ProfileName: profileName } : {}),
    })
    const body = form.toString()
    const ts = String(Date.now())
    const mac = createHmac('sha256', this.env.DEV_FORWARD_SECRET!).update(`${ts}.${body}`).digest('hex')
    const res = await this.fetch('/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Dev-Forward': `${ts}.${mac}` },
      body,
    })
    if (!res.ok) throw new DomainError(`/webhooks/whatsapp answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return sid
  }

  /** The setup page and its form, exactly as the browser submits it when no mail/calendar is connected. */
  async completeOnboarding(token: string, fields: { city: string; interests: string; monthly: number; auto: number; tz?: string }) {
    const page = await this.fetch(`/onboard?t=${encodeURIComponent(token)}`)
    if (page.status !== 200) throw new DomainError(`setup page answered ${page.status}: ${(await page.text()).replace(/<[^>]+>/g, ' ').slice(0, 200)}`)
    const form = new URLSearchParams({
      t: token,
      tz: fields.tz ?? '',
      city: fields.city,
      interests: fields.interests,
      monthly: String(fields.monthly),
      auto: String(fields.auto),
    })
    const res = await this.fetch('/onboard/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const html = await res.text()
    if (!res.ok) throw new DomainError(`/onboard/complete answered ${res.status}: ${html.slice(0, 200)}`)
    return html.match(/<h1>(.*?)<\/h1>/)?.[1] ?? '(no heading)'
  }

  /**
   * New outbox messages after `since`: returns once `done` says so, or once something arrived and nothing new
   * came for `quietMs` (a turn can send more than one message), or at the deadline.
   */
  async waitForMessages(phone: string, since: string, opts: { deadline: number; quietMs: number; done?: (m: ChatMessage[]) => boolean }) {
    const seen = new Map<string, ChatMessage>()
    let lastNew = Date.now()
    let onboardingStatus: string | null = null
    for (;;) {
      const box = await this.outbox(phone, since, 500)
      onboardingStatus = box.onboardingStatus
      for (const m of box.messages) {
        if (!seen.has(m.id)) {
          seen.set(m.id, m)
          lastNew = Date.now()
        }
      }
      const messages = [...seen.values()]
      if (opts.done ? opts.done(messages) : messages.length && Date.now() - lastNew >= opts.quietMs) {
        return { messages, timedOut: false, onboardingStatus }
      }
      if (Date.now() >= opts.deadline) return { messages, timedOut: true, onboardingStatus }
      await sleep(POLL_MS)
    }
  }

  /** One user message in, everything the app sent back during the turn out. */
  async chat(phone: string, text: string, opts: { profileName?: string; deadline: number; quietMs: number; done?: (m: ChatMessage[]) => boolean }) {
    // The database clock, so app and caller agree on "after the send".
    const { now } = await this.outbox(phone, undefined, 1)
    await this.sendInbound(phone, text, opts.profileName)
    return this.waitForMessages(phone, now, opts)
  }
}

export const SETUP_LINK = /\/onboard\?t=([A-Za-z0-9_-]+)/
export const READY = /Ready to go/
export const ONBOARDING_FAILED = /something went wrong while I was reading/

/** Sign up a test user end to end: hello → setup link → form → analysis → "Ready" message. */
export async function onboard(
  app: App,
  input: {
    phone: string
    profileName?: string
    firstMessage: string
    city: string
    interests: string[]
    monthlyBudgetEur: number
    autoApproveEur: number
    timezone?: string
    timeoutSeconds: number
  },
) {
  const deadline = Date.now() + input.timeoutSeconds * 1000
  const steps: { step: string; ok: boolean; detail: string }[] = []
  const messages: ChatMessage[] = []
  const fail = (step: string, detail: string): never => {
    steps.push({ step, ok: false, detail })
    const transcript = messages.map((m) => `  ← ${m.body.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
    throw new DomainError(
      [`chat_onboard failed at "${step}": ${detail}`, ...steps.slice(0, -1).map((s) => `  ✓ ${s.step}: ${s.detail}`), transcript && `Messages:\n${transcript}`]
        .filter(Boolean)
        .join('\n'),
    )
  }

  // 1. First message: a new user gets the setup link.
  const hello = await app.chat(input.phone, input.firstMessage, {
    profileName: input.profileName,
    deadline: Math.min(deadline, Date.now() + 60_000),
    quietMs: 3000,
    // The setup link is the whole reply; anything else (concierge, error) already tells us onboarding won't start.
    done: (ms) => ms.length > 0,
  })
  messages.push(...hello.messages)
  const link = hello.messages.map((m) => SETUP_LINK.exec(m.body)).find(Boolean)
  if (!link) {
    const why =
      hello.onboardingStatus === 'ready'
        ? `${input.phone} is already onboarded (its first message went to the concierge). Run chat_reset first.`
        : hello.onboardingStatus === 'analyzing'
          ? `${input.phone} is still being analysed from an earlier onboarding. Wait, or chat_reset.`
          : hello.timedOut
            ? 'no reply with a setup link (see .atmos/app.log)'
            : 'the reply has no /onboard?t= link'
    fail('first message', why)
  }
  const token = link![1]!
  steps.push({ step: 'first message', ok: true, detail: `got setup link /onboard?t=${token.slice(0, 6)}…` })

  // 2. The setup form, submitted without connecting mail or calendar (the buttons are optional).
  const heading = await app
    .completeOnboarding(token, {
      city: input.city,
      interests: input.interests.join(', '),
      monthly: input.monthlyBudgetEur,
      auto: input.autoApproveEur,
      tz: input.timezone,
    })
    .catch((err: Error) => fail('setup form', err.message))
  steps.push({ step: 'setup form', ok: true, detail: `submitted, page says "${heading}"` })

  // 3. The onboard-user workflow reads (no) mail/calendar, builds the taste profile and sends "Ready to go".
  // `at` has millisecond precision, so the last hello message can come back once more: skip what we have.
  const known = new Set(messages.map((m) => m.id))
  const analysis = await app.waitForMessages(input.phone, hello.messages.at(-1)!.at, {
    deadline,
    quietMs: 0,
    done: (ms) => ms.some((m) => READY.test(m.body) || ONBOARDING_FAILED.test(m.body)),
  })
  analysis.messages = analysis.messages.filter((m) => !known.has(m.id))
  messages.push(...analysis.messages)
  if (analysis.messages.some((m) => ONBOARDING_FAILED.test(m.body))) fail('analysis', 'the onboard-user workflow failed (see .atmos/app.log)')
  if (analysis.timedOut) fail('analysis', `no "Ready to go" message within ${input.timeoutSeconds}s (status ${analysis.onboardingStatus})`)
  steps.push({ step: 'analysis', ok: true, detail: 'got the "Ready to go" message' })

  // The workflow marks the user ready right after sending.
  let status = analysis.onboardingStatus
  for (let i = 0; i < 10 && status !== 'ready'; i++) {
    await sleep(POLL_MS)
    status = (await app.outbox(input.phone, undefined, 1)).onboardingStatus
  }
  if (status !== 'ready') fail('ready', `onboarding status is ${status}, expected ready`)
  steps.push({ step: 'ready', ok: true, detail: 'onboarding_status = ready' })

  return { phone: input.phone, steps, messages, onboardingStatus: status }
}
