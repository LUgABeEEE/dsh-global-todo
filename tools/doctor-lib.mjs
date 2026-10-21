/**
 * A pre-flight check for an installed copy of this plugin.
 *
 * The failure this exists for is specific: a hand-copied `plugins-local` directory
 * usually keeps `lib/`, `package.json` and the patch file, and drops `locale/` —
 * the plugin still loads, the panel still works, and the desktop app prints
 * `Plugin metadata … ENOENT … \locale` on the plugins page. Node resolves the
 * `./locale/*.json` export *without* checking that the file exists, and the Host then
 * scans the directory, which is why the symptom appears far from the cause.
 *
 * Everything here is a pure function of the directory contents, so the test suite can
 * call it without spawning anything.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const EXPORT_LOCALE = './locale/*.json'

const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

const exists = async (file) => {
  try {
    const info = await stat(file)
    return info.isFile() || info.isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {string} dir directory that should contain the plugin, e.g. …/plugins-local/全局待办插件
 * @returns {Promise<{ok: boolean, dir: string, findings: {level: 'ok'|'warn'|'error', id: string, message: string, fix?: string}[], version?: string}>}
 */
export async function doctor(dir) {
  const findings = []
  const add = (level, id, message, fix) => findings.push({ level, id, message, ...(fix === undefined ? {} : { fix }) })

  const manifestFile = path.join(dir, 'package.json')
  const manifest = await readJson(manifestFile)
  if (manifest === null) {
    add('error', 'package-missing', 'package.json 读不到或不是合法 JSON', '把插件目录指到包含 package.json 的那一层（例如 …/plugins-local/全局待办插件）')
    return { ok: false, dir, findings }
  }

  if (manifest.name !== 'dsh-global-todo') {
    add('warn', 'package-name', `package.json 里的 name 是 ${manifest.name ?? '(缺失)'}，不是 dsh-global-todo`, '这个目录可能不是本插件')
  } else {
    add('ok', 'package-name', `${manifest.name}@${manifest.version ?? '?'}`)
  }

  // The patch file is what contributes the Loader row. Without it nothing loads.
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string') {
    add('error', 'patch-declared', 'package.json 没有声明 dsh.bundle.patch', '这不是一个可安装的 DSH bundle')
  } else if (!(await exists(path.join(dir, patch)))) {
    add('error', 'patch-file', `dsh.bundle.patch 指向 ${patch}，但文件不存在`, '从 npm 包重新拷贝，或 `dsh plugin add dsh-global-todo`')
  } else {
    add('ok', 'patch-file', patch)
  }

  // Both halves must exist; the client half is what the panel loads.
  const entry = manifest.exports?.['.']
  const client = manifest.exports?.['./client']
  for (const [label, target] of [['host entry', entry], ['client entry', client]]) {
    if (typeof target !== 'string') {
      add('warn', 'entry-declared', `package.json 没有 ${label} 的 exports`, '宿主可能用默认解析，先确认版本是否完整')
      continue
    }
    if (await exists(path.join(dir, target))) add('ok', 'entry', target)
    else add('error', 'entry-file', `${label} 指向 ${target}，文件不存在`, '这个目录不是完整拷贝：重新从 npm 包复制 lib/')
  }

  // The locale export is the one that fails in the field: the export exists, the
  // directory does not, and the Host reports it as plugin-metadata trouble.
  const localeExport = manifest.exports?.[EXPORT_LOCALE]
  const localeDir = path.join(dir, 'locale')
  const localeExists = await exists(localeDir)
  const files = localeExists ? (await readdir(localeDir).catch(() => [])).filter((name) => name.endsWith('.json')) : []
  if (typeof localeExport === 'string' && !localeExists) {
    add(
      'error',
      'locale-missing',
      'package.json 声明了 ./locale/*.json，但 locale/ 目录不存在 —— 桌面端会显示 Plugin metadata … ENOENT … \\locale',
      '拷贝 locale/ 目录，或用 npm 包重装：dsh plugin add dsh-global-todo（插件本身仍能加载，坏的是插件页标题/描述）',
    )
  } else if (typeof localeExport === 'string' && files.length === 0) {
    add('warn', 'locale-empty', 'locale/ 存在但没有 .json 文件', '至少需要 en.json 与 zh.json')
  } else if (files.length > 0) {
    add('ok', 'locale', `locale/ → ${files.sort().join(', ')}`)
  }

  // The icon is cosmetic: a missing one shows a blank mark, not an error.
  if (await exists(path.join(dir, 'docs', 'icon.svg'))) add('ok', 'icon', 'docs/icon.svg')
  else add('warn', 'icon-missing', 'docs/icon.svg 不存在，插件页会没有图标', '可选：一并拷过去即可，不影响加载')

  const libDir = path.join(dir, 'lib')
  const libFiles = (await exists(libDir)) ? (await readdir(libDir).catch(() => [])).filter((name) => name.endsWith('.js')) : []
  if (libFiles.length === 0) add('error', 'lib-empty', 'lib/ 里没有 .js 文件', '从 npm 包重新复制 lib/')
  else add('ok', 'lib', `lib/ → ${libFiles.length} 个模块`)

  return { ok: !findings.some((finding) => finding.level === 'error'), dir, version: manifest.version, findings }
}

/** One line per finding, for a terminal. */
export function format(report) {
  const mark = { ok: 'OK  ', warn: 'WARN', error: 'FAIL' }
  const lines = [`dsh-global-todo doctor — ${report.dir}`, '']
  for (const finding of report.findings) {
    lines.push(`${mark[finding.level]}  ${finding.message}`)
    if (finding.fix !== undefined) lines.push(`      fix: ${finding.fix}`)
  }
  const errors = report.findings.filter((finding) => finding.level === 'error').length
  const warns = report.findings.filter((finding) => finding.level === 'warn').length
  lines.push('')
  lines.push(errors === 0 ? `OK — ${warns} warning(s)` : `${errors} error(s), ${warns} warning(s)`)
  return lines.join('\n')
}
