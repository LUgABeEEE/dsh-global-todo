# The demo film

`docs/screenshots/demo.mp4` is a 22-second typographic film: five claims, one per screen, with the
product's own interface as evidence. It follows the style Linear, Raycast and Vercel use for
release films, which is worth naming because it is the opposite of a narrated tour:

- **No voiceover.** Type is the narrator. A spoken track would slow it down, and the audience reads
  a UI faster than it hears a sentence. The only TTS endpoints reachable from this host produce a
  synthetic voice, so a narration would have lowered the film rather than raised it.
- **One idea per scene.** Five scenes, five sentences, nothing explaining what the viewer can
  already see.
- **Few motion behaviours, repeated.** A slow push-in on the product card, a rule that draws itself,
  text that rises 16px and fades. Repetition reads as direction; variety reads as a template.
- **The product's own palette, dark.** `#0b0e13`, the same background as the landing page, so the
  film and the page are recognisably the same object.
- **Music instead of silence.** A short instrumental written for this cut: four chords, a sub, a
  bell and air, with the harmony changing exactly on the cuts (0, 4.2, 7.2, 11.4, 14.4, 18.8), so
  the soundtrack edits with the picture. It is synthesised by `tools/demo/music.mjs` — no licence,
  no attribution, and it can be retimed when a scene changes length.

## Where the pictures come from

Real renders, not mockups. A throwaway host is started with `DSH_HOME=/tmp/demo-home` on port 3099,
so this repository is mounted as a plugin against a scratch store — the list you actually use is
never touched. Playwright then drives the real panel in dark mode and captures at 2× (device scale),
which is why the type in the stills is sharp on a 1920×1080 frame.

```sh
mkdir -p /tmp/demo-home
DSH_HOME=/tmp/demo-home dsh plugin --profile web add "$PWD"
node tools/demo/seed.mjs
DSH_HOME=/tmp/demo-home dsh web --no-open --port 3099 --trusted-host 127.0.0.1:3099 &

node tools/demo/capture.mjs            # 5 stills into /tmp/film
sh  tools/demo/scenes.sh               # 6 scenes, type burned in
sh  tools/demo/sound.sh /tmp/music     # the instrumental, timed to the cuts
sh  tools/demo/render.sh /tmp/film/build /tmp/music/mix.wav
```

`tools/demo/scenes.sh` and `tools/demo/music.mjs` both hold the cut positions; move a cut and the
harmony moves with it.

## Honest notes

- The About row in the last product scene shows `~/.dsh/global-todo/todos.json`; the scratch store
  really lives under `/tmp/demo-home`, and that one string is rewritten before the capture. The page
  says the path is illustrative.
- The stills are static captures of real states, not a screen recording. That is a deliberate trade:
  a 2× still is sharper than a 30 fps screencast, and this format does not need to show a cursor.
- `docs/screenshots/tour.gif` remains for places that cannot play video; it is generated separately
  by `npm run tour`.
