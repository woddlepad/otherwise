# Otherwise intro video

A 24.2 second, 1920×1080, 30 fps intro (voiceover and music included) for Otherwise, built with [Remotion](https://remotion.dev). Its look, copy and
data come from `design/homepage/otherwise.html` (tokens, calendar, the "Last week" cards, the budget wheel, the close card).

```bash
npm install
npm run dev            # Remotion Studio, scrub and preview in the browser
npm run render         # out/otherwise-intro.mp4 (H.264, yuv420p bt709, CRF 18, AAC audio)
npm run poster         # out/poster.png (last frame)
npm run stills -- 60 200 440   # PNG stills of any frames into out/stills/, one bundle
# audio stems for checking timing/levels: --props='{"stem":"vo"}' or '{"stem":"music"}'
npx remotion render OtherwiseIntro /tmp/vo-stem.mp4 --props='{"stem":"vo"}' --scale=0.25
```

## Voiceover and music

- `node scripts/vo.mjs --set intro` generates the six intro lines with ElevenLabs (needs `ELEVEN_LABS_API_KEY`,
  speed 1.1), loudness-normalises them to -16 LUFS and writes `public/vo/intro-*.mp3` plus the `intro` section of
  `public/vo/manifest.json` with each clip's speech start/end. `--set intro --measure` re-reads existing clips without
  calling the API. Without `--set` the script still generates the 3-minute demo lines as before.
- `src/timeline.ts` `VO` holds the frame each line starts on; `src/Soundtrack.tsx` plays the lines (each cut 0.15 s
  after its last word) and `public/music/intro.mp3`, ducked 12 dB under speech with 0.3 s ramps. The music is 21 s, so
  its fifth bar (a held tonic bar, 9.6 to 12.0 s at 100 bpm) plays twice to fit 24.2 s and it still ends on its own
  resolve, with a 1 s fade.

If Remotion can't download its headless Chrome, add `--browser-executable=/usr/bin/google-chrome` to the render commands.

## Layout

- `src/timeline.ts`: every timing mark (absolute frames) plus the easing and spring helpers. Change the pacing here.
- `src/Intro.tsx`: stacks the scenes. Scenes overlap during their transitions, which are hand-rolled.
- `src/scenes/`: `Hero` (headline), `SharedCapy` (the capybara that pops in by the headline and then walks onto the
  calendar), `Week`, `Picks` (dark band, liquid-glass stack), `Budget` (wheel and decision line), `Phone`, `Close` (the
  phone body grows into the closing card).
- `src/fonts.ts`: Host Grotesk (variable, 300 to 800) from `public/fonts/`, loaded with `@remotion/fonts` so rendering
  waits for it and never depends on Google Fonts.
- `public/`: mascot and photos copied from `design/homepage/img/`.
