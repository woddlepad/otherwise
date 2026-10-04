import { registerApiRoute } from '@mastra/core/server';
import { ASSETS } from '../../ui/assets.gen';

const decoded = new Map<string, Buffer>();

/**
 * The web UI's images, embedded at build time (scripts/ui-assets.ts). URLs carry `?v=<hash>` (see `asset()` in
 * src/ui/shell.ts), so they can be cached for good. Under /assets/ui/ because `mastra dev` serves Mastra Studio's
 * own files from /assets/* and a custom route there would shadow them.
 */
export const assetFile = registerApiRoute('/assets/ui/:name', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const name = c.req.param('name');
    const file = ASSETS[name];
    if (!file) return c.text('not found', 404);
    let body = decoded.get(name);
    if (!body) decoded.set(name, (body = Buffer.from(file.b64, 'base64')));
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': file.type,
      'Cache-Control': c.req.query('v') === file.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
  },
});
