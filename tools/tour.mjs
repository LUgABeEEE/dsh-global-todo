#!/usr/bin/env node
/**
 * Build the README's state tour from the screenshots that already exist.
 *
 * The frames are the same server-rendered previews `npm run screenshots` writes, in an
 * order that reads like a tour: the list, one row open, the same list again (so the eye
 * returns), then each conditional state. Nothing here is a recording of a session — it
 * is a slideshow of real renders, and it says so.
 *
 * ffmpeg is not a dependency of the plugin. Without it the tool says so and exits 0:
 * a missing GIF must not fail `npm run verify`.
 *
 *   npm run tour            # docs/screenshots/tour.gif
 *   npm run tour -- --out DIR
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = path.join(root, 'docs', 'screenshots')
const OUT_DIR = (() => {
  const index = process.argv.indexOf('--out')
  if (index === -1) return SHOTS
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error('--out needs a directory')
  return path.resolve(value)
})()

/** The tour, in reading order; the list repeats so the eye can come back. */
const FRAMES = [
  'panel.png',
  'panel-detail.png',
  'panel.png',
  'panel-review.png',
  'panel.png',
  'panel-inbox.png',
  'panel.png',
  'panel-reminders.png',
  'panel.png',
  'panel-select.png',
]

const work = mkdtempSync(path.join(tmpdir(), 'gt-tour-'))
try {
  let index = 0
  for (const frame of FRAMES) {
    const source = path.join(SHOTS, frame)
    if (!existsSync(source)) {
      console.error(`missing ${frame} — run "npm run screenshots" first`)
      process.exit(1)
    }
    index += 1
    copyFileSync(source, path.join(work, `${String(index).padStart(3, '0')}.png`))
  }
  const out = path.join(OUT_DIR, 'tour.gif')
  await run('ffmpeg', [
    '-loglevel', 'error', '-y',
    // One frame every two seconds: fast enough to watch, slow enough to read.
    '-framerate', '1/2',
    '-i', path.join(work, '%03d.png'),
    '-vf', 'scale=960:-1:flags=lanczos,split [a][b];[a]palettegen=max_colors=128 [p];[b][p]paletteuse=dither=bayer',
    '-loop', '0',
    out,
  ])
  console.log(`wrote ${out} (${FRAMES.length} frames)`)
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log('ffmpeg is not installed; skipping the tour (it is not a dependency)')
    process.exit(0)
  }
  throw error
} finally {
  rmSync(work, { recursive: true, force: true })
}
