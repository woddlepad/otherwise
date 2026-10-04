import { defineConfig } from '@neon/config/v1';

// Neon injects DATABASE_URL and NEON_AI_GATEWAY_* at runtime, so they must not be listed here
// (a user-defined value would override the injected one). Run `neon deploy --env .env.neon`
// with a file that holds the deployed values; unset keys are left out.
const passthrough = [
  'MODEL',
  'PUBLIC_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'DEMO_CARD_LAST4',
  'EXA_API_KEY',
  'KERNEL_API_KEY',
  'AGENTMAIL_API_KEY',
  'DEV_CHAT_TOKEN',
];

export default defineConfig({
  aiGateway: true,
  functions: {
    agent: {
      name: 'Booking agent (Mastra)',
      source: 'src/index.ts',
      env: Object.fromEntries(passthrough.filter(k => process.env[k]).map(k => [k, process.env[k]!])),
    },
  },
});
