import { strict as assert } from 'node:assert'
import test from 'node:test'

import { weeklyReport } from '../lib/report.js'

const NOW = Date.parse('2026-11-03T10:00:00+08:00')
const DAY = 86_400_000

/** @param {object} [overrides] */
function todo(overrides = {}) {
  return {
    id: 't-00000001',
    seq: 1,
    title: '等你定一下发布顺序',
    description: '',
    status: 'open',
    priority: 'normal',
    dueAt: null,
    tags: [],
    steps: [],
    links: [],
    notes: [],
    activity: [],
    originDir: '/srv/demo',
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    ...overrides,
  }
}
