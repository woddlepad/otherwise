import { Mastra } from '@mastra/core';
import { registerApiRoute } from '@mastra/core/server';
import { PinoLogger } from '@mastra/loggers';
import { PostgresStore } from '@mastra/pg';
import { analyst } from './agents/analyst';
import { concierge } from './agents/concierge';
import { scout } from './agents/scout';
import { billingCheckout, billingRedeem, billingSuccess, devCredits, stripeWebhook, walletPage } from './routes/billing';
import { connectStart, onboardComplete, onboardPage } from './routes/onboarding';
import { cronDiscover, devDiscover } from './routes/discover';
import { eventHandoff } from './routes/handoff';
import { devChat, devOutbox, devResetUser, whatsappWebhook } from './routes/whatsapp';
import { discoverEvents } from './workflows/discover';
import { onboardUser } from './workflows/onboard';

export const mastra = new Mastra({
  agents: { concierge, analyst, scout },
  workflows: { onboardUser, discoverEvents },
  storage: new PostgresStore({
    id: 'booking-agent-storage',
    connectionString: process.env.DATABASE_URL!,
  }),
  logger: new PinoLogger({ name: 'booking-agent', level: 'info' }),
  server: {
    apiRoutes: [
      whatsappWebhook,
      devChat,
      devOutbox,
      devResetUser,
      onboardPage,
      connectStart,
      onboardComplete,
      walletPage,
      billingCheckout,
      billingSuccess,
      billingRedeem,
      stripeWebhook,
      devCredits,
      cronDiscover,
      devDiscover,
      eventHandoff,
      registerApiRoute('/health', {
        method: 'GET',
        requiresAuth: false,
        handler: c => c.json({ ok: true }),
      }),
    ],
  },
});
