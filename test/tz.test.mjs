import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Timezone semantics cannot be tested in the process that runs the suite: CI is UTC, where
 * a UTC-midnight anchor and a local-midnight anchor are the same number. Issue #6 only
 * appears on machines with a non-zero offset, so the discrimination has to happen in a
 * child process with a chosen TZ.
 *
 * Windows ignores the TZ variable in Node, so there the child reports offset 0 and the
 * assertion is skipped rather than pretending to have tested it.
 */
const root = fileURLToPath(new URL('..', import.meta.url))

function childReport(tz) {
  const script = [
    "import('./lib/model.js').then((m) => {",
    '  process.stdout.write(JSON.stringify({',
    '    offset: new Date().getTimezoneOffset(),',
    "    dateOnly: m.parseDueText('2026-11-01').iso,",
    '    local: new Date(2026, 10, 1).toISOString(),',
    '  }))',
    '})',
  ].join('\n')
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  })
  return JSON.parse(output)
}

test('a date-only deadline is local midnight even away from UTC', (t) => {
  const report = childReport('Asia/Shanghai')
  if (report.offset === 0) {
    t.skip('this platform ignores TZ, so the offset cannot be forced here')
    return
  }
  assert.equal(report.dateOnly, report.local, 'the bound must be the local start of the day, not UTC midnight')
})

test('a date-only bound excludes that local day, on a +08 machine', (t) => {
  const report = childReport('Asia/Shanghai')
  if (report.offset === 0) {
    t.skip('this platform ignores TZ, so the offset cannot be forced here')
    return
  }
  // The bug from #6: a todo due local 07:00 on the bound day used to satisfy before:<that day>.
  const dueLocal0700 = Date.parse('2026-11-01T07:00:00+08:00')
  const bound = Date.parse(report.dateOnly)
  assert.ok(dueLocal0700 > bound, 'the bound day itself must not be inside before:<bound day>')
})
