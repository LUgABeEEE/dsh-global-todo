/**
 * How much a captured candidate looks like a real todo.
 *
 * The batch capture tool is asked for "anything worth following up", and models oblige:
 * they return hedged observations ("maybe look at the log later"), questions, and the
 * occasional aside. Rather than trusting the model's own ordering, each candidate gets a
 * small, explicit weight from signals a person would recognise, and anything below the
 * configured threshold is reported as skipped instead of filling the list.
 *
 * The score is deliberately explainable: every contribution is named, so the skip reason
 * can say *why* something was left out rather than "low quality".
 *
 * @module dsh-global-todo/weight
 */

/** A phrase that reads like a commitment rather than an observation. */
const COMMITMENT = ['记得', '别忘', '回头', '下周', '明天', '后天', '截止', 'deadline', '要交', '待确认', '等回复', '跟进', '安排', '发我', '确认一下', '记得要', '别忘了']

/** A phrase that reads like thinking aloud. */
const HESITATION = ['可能', '也许', '考虑', '有空', '再说', '看看', '随便', '或许', '不确定', 'optional']

/** Default threshold; a bare one-line observation scores below it. */
export const DEFAULT_MIN_WEIGHT = 0.35

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/**
 * @param {unknown} item - a candidate as the capture tool receives it
 * @param {{ now?: number }} [options]
 * @returns {{ weight: number, signals: { id: string, delta: number, note: string }[] }}
 */
export function scoreItem(item, options = {}) {
  const signals = []
  const add = (id, delta, note) => signals.push({ id, delta, note })
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { weight: 0, signals: [{ id: 'shape', delta: 0, note: '不是对象' }] }
  }
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  const description = typeof item.description === 'string' ? item.description.trim() : ''
  const text = `${title} ${description}`
  const length = [...title].length

  // The title says how specific the errand is. A one-character title cannot.
  if (length >= 10) add('specific', 0.15, '标题足够具体')
  else if (length >= 6) add('specific', 0.1, '标题较具体')
  else if (length >= 3) add('specific', 0.05, '标题偏短')
  else add('tiny', -0.15, '标题几乎没有信息')

  const due = typeof item.dueAt === 'string' && Number.isFinite(Date.parse(item.dueAt))
  if (due) add('due', 0.2, '有可解析的截止时间')

  if (Array.isArray(item.steps) && item.steps.length > 0) add('steps', 0.15, '已经拆成步骤')
  if (Array.isArray(item.links) && item.links.length > 0) add('links', 0.1, '挂了文档或地址')
  if (typeof item.evidence === 'string' && item.evidence.trim() !== '') add('evidence', 0.1, '引用了原话')
  if (item.priority === 'urgent') add('priority', 0.15, '标了 P0')
  else if (item.priority === 'high') add('priority', 0.1, '标了 P1')

  const hesitation = HESITATION.find((word) => text.includes(word))
  if (hesitation !== undefined) add('hesitation', -0.2, `含犹豫语「${hesitation}」`)
  // A hedged sentence does not also earn the commitment bonus: 「回头再说吧，有空看看」 contains
  // 「回头」, and crediting it for that is exactly how an aside becomes a todo.
  const commitment = hesitation === undefined ? COMMITMENT.find((word) => text.includes(word)) : undefined
  if (commitment !== undefined) add('commitment', 0.15, `含承诺语「${commitment}」`)

  if (/[？?]\s*$/.test(title)) add('question', -0.15, '标题是疑问句')

  // A naked one-liner with nothing attached is the shape of an aside.
  if (description === '' && !due && !(Array.isArray(item.steps) && item.steps.length > 0) && !(Array.isArray(item.links) && item.links.length > 0)) {
    add('naked', -0.1, '没有任何补充信息')
  }

  // The base is what a bare, plausible errand scores: specific enough to state, with nothing
  // attached yet. Everything above or below that is a named signal.
  const weight = clamp01(Math.round((0.45 + signals.reduce((sum, signal) => sum + signal.delta, 0)) * 100) / 100)
  return { weight, signals }
}

/**
 * @param {unknown} weight
 * @param {number} [fallback]
 * @returns {number} a threshold in 0..1
 */
export function normalizeThreshold(weight, fallback = DEFAULT_MIN_WEIGHT) {
  const value = Number(weight)
  if (!Number.isFinite(value)) return fallback
  return clamp01(Math.round(value * 100) / 100)
}
