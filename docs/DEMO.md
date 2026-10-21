# The demo film

`docs/screenshots/demo.mp4` is a 22-second typographic film: five claims, one per screen, with the
product's own interface as evidence. It follows the style Linear, Raycast and Vercel use for
release films, which is worth naming because it is the opposite of a narrated tour:

- **No voiceover.** Type is the narrator. A spoken track would slow it down, and the audience reads
  a UI faster than it hears a sentence.
- **One idea per scene.** Five scenes, five sentences, nothing explaining what the viewer can
  already see.
- **Few motion behaviours, repeated.** A slow push-in on the product card, a rule that draws itself,
  text that rises 16px and fades. Repetition reads as direction; variety reads as a template.
- **The product's own palette, dark.** `#0b0e13`, the same background as the landing page, so the
  film and the page are recognisably the same object.
- **Sound marks events, it does not fill time.** A filtered noise tick on each cut, a low thud under
  the two statement scenes, and a quiet 55/82.5 Hz pad underneath.

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
sh  tools/demo/scenes.sh               # 6 scenes + sound, muxed by render.sh
```

`tools/demo/render.sh` holds the timing constants (scene lengths, cut positions). Change a sentence
and the numbers next to it; nothing else needs touching.

## Honest notes

- The About row in the last product scene shows `~/.dsh/global-todo/todos.json`; the scratch store
  really lives under `/tmp/demo-home`, and that one string is rewritten before the capture. The page
  says the path is illustrative.
- The stills are static captures of real states, not a screen recording. That is a deliberate trade:
  a 2× still is sharper than a 30 fps screencast, and this format does not need to show a cursor.
- `docs/screenshots/tour.gif` remains for places that cannot play video; it is generated separately
  by `npm run tour`.
