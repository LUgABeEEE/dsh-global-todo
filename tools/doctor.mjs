#!/usr/bin/env node
/**
 * dsh-global-todo-doctor — check that a directory really contains this plugin.
 *
 *   npx dsh-global-todo-doctor "~/.dsh/plugins-local/全局待办插件"
 *   node tools/doctor.mjs .            # from a checkout
 *
 * Exists because the field failure is silent-ish: a hand-copied plugin directory
 * without `locale/` still loads, and only the desktop plugins page complains.
 */
import { doctor, format } from './doctor-lib.mjs'
import path from 'node:path'

const args = process.argv.slice(2).filter((value) => value !== '')
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('用法 / usage:\n  dsh-global-todo-doctor [插件目录]\n\n默认检查当前目录。\n')
  process.exit(0)
}

const target = path.resolve(args[0] ?? process.cwd())
const report = await doctor(target)
process.stdout.write(format(report) + '\n')
process.exit(report.ok ? 0 : 1)
