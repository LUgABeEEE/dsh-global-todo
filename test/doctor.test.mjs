import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { doctor } from '../tools/doctor-lib.mjs'

const root = path.resolve(import.meta.dirname, '..')

/** Copy the pieces a naive hand-copy keeps, so a test can delete exactly one of them. */
async function fixture(withLocale = true, withIcon = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-doctor-'))
  await mkdir(path.join(dir, 'lib'), { recursive: true })
  await cp(path.join(root, 'package.json'), path.join(dir, 'package.json'))
  await cp(path.join(root, 'cordis.patch.yml'), path.join(dir, 'cordis.patch.yml'))
  await cp(path.join(root, 'lib', 'index.js'), path.join(dir, 'lib', 'index.js'))
  await cp(path.join(root, 'lib', 'client.js'), path.join(dir, 'lib', 'client.js'))
  if (withLocale) {
    await mkdir(path.join(dir, 'locale'), { recursive: true })
    await cp(path.join(root, 'locale', 'en.json'), path.join(dir, 'locale', 'en.json'))
    await cp(path.join(root, 'locale', 'zh.json'), path.join(dir, 'locale', 'zh.json'))
  }
  if (withIcon) {
    await mkdir(path.join(dir, 'docs'), { recursive: true })
    await cp(path.join(root, 'docs', 'icon.svg'), path.join(dir, 'docs', 'icon.svg'))
  }
  return dir
}

const ids = (report) => report.findings.map((finding) => finding.id)

test('a complete directory passes', async () => {
  const dir = await fixture()
  try {
    const report = await doctor(dir)
    assert.equal(report.ok, true)
    assert.equal(report.findings.some((finding) => finding.level === 'error'), false)
    assert.match(report.version, /^\d+\.\d+\.\d+$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a copy without locale/ is the field failure, and it is reported as one', async () => {
  const dir = await fixture(false)
  try {
    const report = await doctor(dir)
    assert.equal(report.ok, false)
    const finding = report.findings.find((entry) => entry.id === 'locale-missing')
    assert.ok(finding, 'locale-missing must be reported')
    assert.match(finding.message, /ENOENT/)
    assert.match(finding.fix, /dsh plugin add/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing host or client entry is an error, not a warning', async () => {
  const dir = await fixture()
  try {
    await rm(path.join(dir, 'lib', 'client.js'))
    const report = await doctor(dir)
    assert.equal(report.ok, false)
    assert.ok(ids(report).includes('entry-file'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing patch file is an error', async () => {
  const dir = await fixture()
  try {
    await rm(path.join(dir, 'cordis.patch.yml'))
    const report = await doctor(dir)
    assert.equal(report.ok, false)
    assert.ok(ids(report).includes('patch-file'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing icon is only a warning: nothing stops loading', async () => {
  const dir = await fixture(true, false)
  try {
    const report = await doctor(dir)
    assert.equal(report.ok, true)
    const icon = report.findings.find((entry) => entry.id === 'icon-missing')
    assert.equal(icon?.level, 'warn')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a directory that is not the plugin at all is rejected up front', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-doctor-empty-'))
  try {
    const report = await doctor(dir)
    assert.equal(report.ok, false)
    assert.deepEqual(ids(report), ['package-missing'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
