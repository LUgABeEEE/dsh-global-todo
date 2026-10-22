/**
 * Attachments: a todo may reference any number of documents and addresses.
 *
 * Design decision — **references, not uploads.** An attachment is a URL or an
 * absolute file path that stays where it is; the plugin never copies bytes into
 * its own storage. A document therefore remains editable, diffable and
 * git-able, the list stays small, and an agent session can open the very same
 * path with its own tools. This is deliberately different from the image
 * attachments other todo plugins ship, whose bytes are copied into an
 * attachment store and whose context value is limited to what a model can see.
 *
 * This module is pure: no filesystem access. Existence checking is injected by
 * the caller so the rules can be unit-tested without touching disk.
 *
 * @module dsh-global-todo/links
 */

import { TodoError } from './errors.js'

/**
 * Accepted attachment kinds.
 *
 * `image` is a reference like `file` — the bytes stay where they are — but it is
 * declared rather than inferred, because the panel renders it and a guess would
 * turn a random document into a broken thumbnail. The list still never copies
 * bytes; `GET /asset` reads the referenced file on demand.
 */
export const LINK_KINDS = Object.freeze(['url', 'file', 'image'])

/** Extensions the panel can actually render. SVG is excluded: served inline from the same
 * origin it can carry script. */
export const IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])

/**
 * @param {string} value
 * @returns {boolean} whether the path looks like a renderable image
 */
export function isImagePath(value) {
  const lower = String(value ?? '').toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

const MAX_URL = 2048
const MAX_PATH = 4096
const MAX_TITLE = 200

/**
 * Guess the kind of a bare string attachment.
 *
 * `image` is never inferred: it is a rendering decision the caller states.
 *
 * @param {string} value
 * @returns {'url' | 'file'}
 */
export function inferLinkKind(value) {
  return /^https?:\/\//i.test(value.trim()) ? 'url' : 'file'
}

/**
 * Normalize one attachment.
 *
 * Accepts either a bare string (`https://…` or `/abs/path.md`) or an object
 * `{ kind, value, title }`. `kind` may be omitted and is then inferred.
 *
 * @param {unknown} input
 * @param {object} [options]
 * @param {boolean} [options.requireExistingFiles] - reject file links whose path is missing
 * @param {(path: string) => boolean} [options.exists] - existence probe, injected
 * @returns {{ kind: 'url' | 'file', value: string, title: string }}
 */
export function normalizeLink(input, options = {}) {
  const raw = typeof input === 'string' ? { value: input } : input
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TodoError('invalid-link', '附件必须是字符串，或 { kind, value, title } 对象')
  }

  const value = typeof raw.value === 'string' ? raw.value.trim() : ''
  if (value === '') throw new TodoError('invalid-link', '附件的 value 不能为空')
  if (value.includes('\0')) throw new TodoError('invalid-link', '附件的 value 含有 NUL 字符')

  const declared = typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : undefined
  if (declared !== undefined && !LINK_KINDS.includes(declared)) {
    throw new TodoError('invalid-link', `附件类型必须是 ${LINK_KINDS.join(' 或 ')}，收到 ${declared}`)
  }
  const kind = declared ?? inferLinkKind(value)

  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title.length > MAX_TITLE) {
    throw new TodoError('invalid-link', `附件标题最多 ${MAX_TITLE} 个字符`)
  }

  if (kind === 'url') {
    if (value.length > MAX_URL) throw new TodoError('invalid-link', `地址最多 ${MAX_URL} 个字符`)
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      throw new TodoError('invalid-link', `不是合法地址：${value}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TodoError('invalid-link', `只接受 http/https 地址，收到 ${parsed.protocol}`)
    }
    if (parsed.username !== '' || parsed.password !== '') {
      // A URL that carries credentials would persist a secret into the list,
      // into the activity trail and into every dispatch prompt.
      throw new TodoError('invalid-link', '地址里不允许带用户名或密码')
    }
    const normalized = parsed.toString()
    return { kind, value: normalized, title: title === '' ? defaultLinkTitle(kind, normalized) : title }
  }

  if (value.length > MAX_PATH) throw new TodoError('invalid-link', `文件路径最多 ${MAX_PATH} 个字符`)
  if (!isAbsolutePath(value)) {
    throw new TodoError('invalid-link', `文档请给绝对路径（相对路径会在不同会话下指向不同文件）：${value}`)
  }
  if (kind === 'image' && !isImagePath(value)) {
    throw new TodoError('invalid-link', `图片附件需要图片扩展名（${IMAGE_EXTENSIONS.join(' / ')}）：${value}`)
  }
  if (options.requireExistingFiles === true && typeof options.exists === 'function' && !options.exists(value)) {
    throw new TodoError('invalid-link', `找不到这个文件：${value}`)
  }
  return { kind, value, title: title === '' ? defaultLinkTitle(kind, value) : title }
}

/**
 * @param {string} value
 * @returns {boolean} POSIX absolute, Windows drive absolute, or UNC
 */
export function isAbsolutePath(value) {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * A readable default title so the panel never shows a bare 200-character path.
 *
 * @param {'url' | 'file'} kind
 * @param {string} value
 * @returns {string}
 */
export function defaultLinkTitle(kind, value) {
  if (kind === 'file' || kind === 'image') {
    const parts = value.split(/[\\/]/).filter(Boolean)
    return parts.length === 0 ? value : parts[parts.length - 1]
  }
  try {
    const parsed = new URL(value)
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.hostname}${path}`
  } catch {
    return value
  }
}

/**
 * Identity of an attachment inside one todo. Two links are the same when their
 * kind and value match; the title is presentation only.
 *
 * @param {{ kind: string, value: string }} link
 * @returns {string}
 */
export function linkKey(link) {
  return `${link.kind}\u0000${link.value}`
}

/**
 * One line for a prompt or a tool result.
 *
 * @param {{ kind: string, value: string, title?: string }} link
 * @returns {string}
 */
export function formatLink(link) {
  const title = typeof link.title === 'string' && link.title !== '' ? link.title : defaultLinkTitle(link.kind, link.value)
  return `${title} — ${link.value}`
}
