// Render a list of frames as PNG stills with one bundle: node scripts/stills.mjs 30 90 150 ...
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const frames = process.argv.slice(2).map(Number);
const serveUrl = await bundle({entryPoint: path.join(root, 'src/index.ts')});
const composition = await selectComposition({serveUrl, id: 'OtherwiseIntro'});
for (const frame of frames) {
  const output = path.join(root, 'out/stills', `f${String(frame).padStart(3, '0')}.png`);
  await renderStill({serveUrl, composition, frame, output, overwrite: true});
  console.log(output);
}
