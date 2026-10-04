import { randomUUID } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { db } from './db';
import { sendWhatsApp } from './whatsapp';

/**
 * Writes a message the app sent on its own (morning picks, booking updates) into the user's concierge thread as an
 * assistant message, so a reply like "2" or "yes" reaches an agent that knows what it answers. Never throws.
 */
export async function appendToThread(mastra: Mastra | undefined, userId: string, phone: string, text: string) {
  try {
    const memory = await mastra?.getAgent('concierge').getMemory();
    if (!memory) return;
    const threadId = `wa:${phone}`;
    if (!(await memory.getThreadById({ threadId }))) await memory.createThread({ threadId, resourceId: userId });
    await memory.saveMessages({
      messages: [
        {
          id: randomUUID(),
          role: 'assistant',
          createdAt: new Date(),
          threadId,
          resourceId: userId,
          type: 'text',
          content: { format: 2, parts: [{ type: 'text', text }] },
        },
      ],
    });
  } catch (err) {
    console.warn('[thread] could not save a message to the chat thread:', String(err).slice(0, 200));
  }
}

/** WhatsApp a user and note it in their concierge thread; `internal` is only for the agent (ids, state). */
export async function tellUser(mastra: Mastra | undefined, userId: string, text: string, internal?: string) {
  const { rows } = await db.query<{ phone: string }>(`SELECT phone FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return;
  await sendWhatsApp(rows[0].phone, text);
  await appendToThread(mastra, userId, rows[0].phone, internal ? `${text}\n\n(internal: ${internal})` : text);
}
