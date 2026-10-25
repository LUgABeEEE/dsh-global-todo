#!/usr/bin/env node
/**
 * Compatibility matrix smoke.
 *
 * The Host decides whether a bundle loads from `engines.dsh`, and a miss is not a
 * warning: the whole bundle is skipped and the panel is simply absent. This script
 * checks the runtime the profile actually has against the range the package declares,
 * then runs the tests that touch the Host contracts the plugin depends on.
 *
 * It deliberately does not run `npm run verify`: that writes preview/ and photographs
 * the panel, which a matrix run does not need.
 */
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const range = typeof pkg.engines?.dsh === "string" ? pkg.engines.dsh : ""

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split(".") : [] }
}

function comparePre(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b)
      if (delta !== 0) return delta < 0 ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

function compare(left, right) {
  const keys = ["major", "minor", "patch"]
  for (const key of keys) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePre(left.pre, right.pre)
}

/**
 * Only the comparator forms a plugin manifest actually uses: `>=`, `>`, `<=`, `<`, `=`.
 * Anything fancier (caret, tilde, `||`, wildcards) throws instead of passing by accident.
 */
function satisfies(version, rangeText) {
  const runtime = parseVersion(version)
  if (runtime === null) throw new Error(`not a version: ${version}`)
  const parts = String(rangeText).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  for (const part of parts) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part)
    const operator = match[1] ?? "="
    const target = parseVersion(match[2])
    if (target === null) throw new Error(`unsupported range token: ${part} (use plain comparators)`)
    const order = compare(runtime, target)
    const ok =
      operator === ">=" ? order >= 0 : operator === ">" ? order > 0 : operator === "<=" ? order <= 0 : operator === "<" ? order < 0 : order === 0
    if (!ok) return false
  }
  return true
}

// Self-check: these are the cases the manifest has actually used, plus the one that matters
// when 0.3.0 lands.
assert.equal(satisfies("0.2.1-rc.2", ">=0.2.0-rc.1 <0.3.0"), true)
assert.equal(satisfies("0.3.0", ">=0.2.0-rc.1 <0.3.0"), false)
assert.equal(satisfies("0.2.0-rc.1", ">=0.2.0-rc.1"), true)
assert.equal(satisfies("0.2.0-alpha.5", ">=0.2.0-rc.1"), false)
assert.equal(satisfies("0.4.0", ">=0.2.0-rc.1 <0.4.0"), false)

let runtime = ""
try {
  runtime = execFileSync("dsh", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
} catch {
  console.warn("SKIP  no dsh on PATH; the engines gate could not be checked")
}

console.log(`plugin dsh-global-todo@${pkg.version}`)
console.log(`engines.dsh ${range}`)
if (runtime !== "") {
  console.log(`runtime dsh ${runtime}`)
  if (!satisfies(runtime, range)) {
    console.error(`FAIL  dsh ${runtime} is outside ${range}; the Host will skip this bundle`)
    process.exitCode = 1
  } else {
    console.log("OK    runtime satisfies engines.dsh")
  }
}

execFileSync(process.execPath, ["--test", "test/manifest.test.mjs", "test/bundle.test.mjs", "test/schema.test.mjs"], {
  cwd: root,
  stdio: "inherit",
})
console.log("OK    manifest, bundle and tool-schema contracts")
