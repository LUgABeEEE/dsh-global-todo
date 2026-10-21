# The demo video

`docs/screenshots/demo.mp4` is a 38-second narrated recording of the real panel, not stitched
screenshots. It is produced locally, in four steps, without touching the list you actually use.

## Why it is recorded this way

- **A throwaway host.** The recording runs `dsh web` with `DSH_HOME=/tmp/demo-home` on port 3099,
  so it mounts this repository as a plugin against a scratch store. The production host and the
  production `todos.json` are never involved, and nothing is restarted.
- **Real interaction.** Playwright drives the panel: open it, expand a todo, tick a step, answer an
  agent's completion, open settings. A drawn cursor and click ripple are injected so the video has
  a pointer (a headless recording otherwise has none).
- **Narration drives the timing.** Six zh-CN lines are synthesised first, measured, and the scene
  waits in the recorder are derived from those durations. Captions are burned in, so the video still
  works muted.
- **The About row is illustrative.** The demo store lives in a scratch home, so the displayed path
  would read `/tmp/demo-home/...`. That one string is replaced with `~/.dsh/global-todo/todos.json`
  for the scene, and the page says the path is illustrative.

## Regenerating it

```sh
# 1. a scratch home with the plugin mounted, seeded with demo data
mkdir -p /tmp/demo-home
DSH_HOME=/tmp/demo-home dsh plugin --profile web add "$PWD"
node tools/demo/seed.mjs
DSH_HOME=/tmp/demo-home dsh web --no-open --port 3099 --trusted-host 127.0.0.1:3099 &

# 2. narrate (a public TTS endpoint; if it is down, the captions still carry the video)
sh tools/demo/tts.sh /tmp/voice

# 3. record (needs playwright; the repo does not depend on it)
node tools/demo/record.mjs /tmp/demo-rec

# 4. assemble: captions, music bed, end card
sh tools/demo/render.sh /tmp/demo-rec /tmp/voice docs/screenshots/demo.mp4
```

The recorder prints scene offsets in seconds; the render script uses them to place the narration.
When a scene changes length, update the offsets in `render.sh` to match — the numbers are not magic,
they are just where each scene starts.

## What is *not* in the video

Nothing is faked except that one path string: the todos, the steps, the review badge and the files
are the ones `tools/demo/seed.mjs` writes through the real service.
