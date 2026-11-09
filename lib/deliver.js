// How the plan reaches the model as a conversation message instead of the
// system prompt. Everything this needs — what was delivered last, whether a
// compaction swallowed it, which of the user's own words a compaction
// replaced, how many steps went by — is folded from the session log, so a
// restart or a resume reads the same answer. No DSH imports, so the rules stay
// unit-testable.

import crypto from 'node:crypto'

import { EMPTY_HASH } from './core.js'

export const KIND = 'living-plan'
export const PROJECTION_KEY = 'livingPlan'
export const PROJECTION_VERSION = 2

export const DEFAULTS = Object.freeze({
  refreshSteps: 40,
  remindAfterSteps: 3,
  noPlanAfterSteps: 8,
  ledgerMaxBytes: 6144,
  ledgerFirstBytes: 1536,
  ledgerEachBytes: 640,
  quoteBytes: 480,
})

export function initialState() {
  return {
    delivered: null,
    users: [],
    swallowed: [],
    lastUser: null,
    steps: 0,
    remindedFor: null,
    noPlanFor: null,
  }
}

function isSeqList(value) {
  return Array.isArray(value) && value.every((seq) => Number.isSafeInteger(seq) && seq >= 0)
}

// The projection registry only asks for parse(): it validates a checkpointed
// state before trusting it.
export const stateSchema = {
  parse(value) {
    const ok = value !== null && typeof value === 'object'
      && isSeqList(value.users) && isSeqList(value.swallowed)
      && Number.isSafeInteger(value.steps)
      && (value.delivered === null || (typeof value.delivered === 'object' && Number.isSafeInteger(value.delivered.seq) && typeof value.delivered.hash === 'string'))
      && (value.lastUser === null || (typeof value.lastUser === 'object' && Number.isSafeInteger(value.lastUser.seq)))
      && (value.remindedFor === null || Number.isSafeInteger(value.remindedFor))
      && (value.noPlanFor === null || typeof value.noPlanFor === 'string')
    if (!ok) throw new TypeError('living-plan projection state is malformed')
    return value
  },
}

function isReplacement(event) {
  const op = event.surfaceOp
  return op !== undefined && op !== 'append' && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0
}

function swallow(state, event) {
  const sources = new Set(event.sourceEventSeqs)
  const delivered = state.delivered
  const deliveredGone = delivered !== null && !delivered.swallowed && sources.has(delivered.seq)
  // Only a compaction loses the user's words; other replacements (a system
  // prompt rewrite, an image omission) keep them readable.
  const compaction = event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint'
  const already = new Set(state.swallowed)
  const newly = compaction ? state.users.filter((seq) => sources.has(seq) && !already.has(seq)) : []
  if (!deliveredGone && newly.length === 0) return state
  return {
    ...state,
    delivered: deliveredGone ? { ...delivered, swallowed: true } : delivered,
    swallowed: newly.length > 0 ? [...state.swallowed, ...newly] : state.swallowed,
  }
}

/**
 * Fold one committed session event. Unrelated events return the same state
 * object, as the projection registry requires.
 */
export function applyEvent(state, event) {
  if (isReplacement(event)) return swallow(state, event)
  if (event.type === 'step/start') {
    return {
      ...state,
      steps: state.steps + 1,
      delivered: state.delivered === null ? null : { ...state.delivered, steps: state.delivered.steps + 1 },
      lastUser: state.lastUser === null ? null : { ...state.lastUser, steps: state.lastUser.steps + 1 },
    }
  }
  if (event.type !== 'user/message') return state
  const source = event.data?.source
  if (source?.kind === 'user') {
    return {
      ...state,
      users: [...state.users, event.seq],
      lastUser: { seq: event.seq, time: Number(event.time) || 0, steps: 0 },
    }
  }
  if (source?.kind !== KIND) return state
  const note = source.livingPlan
  if (note?.form === 'plan') {
    return {
      ...state,
      delivered: {
        seq: event.seq,
        sessionId: String(note.sessionId ?? ''),
        hash: String(note.hash ?? ''),
        version: Number(note.version) || 0,
        ledger: Number(note.ledger) || 0,
        refresh: Number(note.refresh) || 0,
        steps: 0,
        swallowed: false,
      },
    }
  }
  if (note?.form === 'reminder') {
    return {
      ...state,
      remindedFor: Number.isSafeInteger(note.remindedFor) ? note.remindedFor : state.remindedFor,
      // Per session: a copied session's own "no plan yet" is a new question.
      // 0.3.0 notes carry no session id; take them as answered.
      noPlanFor: note.noPlan === true ? String(note.sessionId ?? 'legacy') : state.noPlanFor,
    }
  }
  return state
}

export const projection = {
  key: PROJECTION_KEY,
  stateVersion: PROJECTION_VERSION,
  stateSchema,
  init: () => initialState(),
  apply: applyEvent,
}

function updatedBefore(plan, time) {
  const at = plan.updatedAt ? Date.parse(plan.updatedAt) : NaN
  return !Number.isFinite(at) || at < time
}

/**
 * Decide what this step must carry. `plan` is a PlanStore.refresh() result.
 * Returns the plan delivery (or null) and at most one reminder.
 */
export function decide(state, plan, sessionId, options = DEFAULTS) {
  const own = state.delivered !== null && state.delivered.sessionId === String(sessionId) ? state.delivered : null
  const hasPlan = plan.exists && plan.text.trim() !== ''
  const ledger = state.swallowed.length
  const hash = hasPlan ? plan.hash : EMPTY_HASH
  // The conversation was copied from another session (a branch, a move to
  // another workspace) whose plan it still shows; this session has no plan
  // file of its own yet. The caller carries the parent's plan over.
  const parent = own === null && !plan.exists && plan.version === 0 && state.delivered !== null
    && state.delivered.hash !== EMPTY_HASH && state.delivered.sessionId !== String(sessionId)
    ? { sessionId: state.delivered.sessionId, version: state.delivered.version, hash: state.delivered.hash }
    : null
  let reason = null
  if (parent !== null) {
    reason = 'orphan'
  } else if (own !== null && own.hash !== EMPTY_HASH && !hasPlan) {
    // The user deleted the plan file: what was delivered no longer holds.
    reason = 'cleared'
  } else if (hasPlan || ledger > 0) {
    if (own === null) reason = hasPlan ? 'first' : 'ledger'
    else if (own.hash !== hash) reason = plan.updatedBy === 'user' ? 'user' : 'new'
    else if (own.swallowed) reason = 'swallowed'
    else if (ledger > own.ledger) reason = 'ledger'
    else if (hasPlan && options.refreshSteps > 0 && own.steps >= options.refreshSteps) reason = 'refresh'
  }
  // With the plan in the system prompt (placement: system) nothing is posted;
  // the reminders still are.
  if (options.deliver === false) reason = null

  let reminder = null
  const user = state.lastUser
  if (reason === null || reason === 'refresh') {
    if (hasPlan && user !== null && options.remindAfterSteps > 0 && user.steps >= options.remindAfterSteps
      && state.remindedFor !== user.seq && updatedBefore(plan, user.time)) {
      reminder = { kind: 'changed', seq: user.seq, steps: user.steps }
    } else if (!plan.exists && options.noPlanAfterSteps > 0 && state.noPlanFor !== String(sessionId)
      && state.noPlanFor !== 'legacy' && state.steps >= options.noPlanAfterSteps) {
      reminder = { kind: 'no-plan', steps: state.steps }
    }
  }
  return {
    reason,
    parent,
    refresh: reason === 'refresh' ? (own?.refresh ?? 0) + 1 : 0,
    ledgerSeqs: [...state.swallowed],
    reminder,
    // The model holds the current version when it is on screen and unswallowed.
    holdsCurrent: hasPlan && own !== null && own.hash === plan.hash && !own.swallowed,
  }
}

// ---- rendering --------------------------------------------------------------

export function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  let other = 0
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else other += 1
  }
  const text = parts.join('\n').trim()
  return other > 0 ? (text ? text + '\n' : '') + '［另有 ' + other + ' 个附件］' : text
}

function stampOf(time) {
  const date = new Date(Number(time))
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function quoteLines(text) {
  return text.split('\n').map((line) => '> ' + line).join('\n')
}

/**
 * Pick the swallowed user messages to show verbatim: the first one in the
 * session as fully as the budget allows, then the newest, oldest-first in the
 * output. `read(seq)` returns { text, time } or null.
 */
export function ledgerEntries(seqs, firstSeq, read, options = DEFAULTS) {
  const items = seqs.map((seq) => ({ seq, ...(read(seq) ?? { text: '', time: 0 }) })).filter((item) => item.text !== '')
  if (items.length === 0) return { entries: [], omitted: 0 }
  const clip = (item, limit) => {
    const cut = truncateUtf8(item.text, limit)
    return { ...item, shown: cut.text + (cut.truncated ? '……［截断，原文 ' + item.text.length + ' 字］' : '') }
  }
  let budget = options.ledgerMaxBytes
  const chosen = new Map()
  const first = items.find((item) => item.seq === firstSeq)
  if (first !== undefined) {
    const entry = clip(first, Math.min(options.ledgerFirstBytes, budget))
    chosen.set(first.seq, entry)
    budget -= Buffer.byteLength(entry.shown, 'utf8')
  }
  // A sliver of a message misleads more than it tells: stop below this.
  const least = 160
  for (let index = items.length - 1; index >= 0 && budget >= least; index -= 1) {
    const item = items[index]
    if (chosen.has(item.seq)) continue
    const entry = clip(item, Math.min(options.ledgerEachBytes, budget))
    chosen.set(item.seq, entry)
    budget -= Buffer.byteLength(entry.shown, 'utf8')
  }
  const entries = items.filter((item) => chosen.has(item.seq)).map((item) => chosen.get(item.seq))
  return { entries, omitted: items.length - entries.length }
}

const REASONS = {
  first: '这是当前计划。之后计划有改动会再贴出新版，以对话里最新的一份为准。',
  new: '计划已更新：本版取代此前贴出的所有版本。',
  user: '用户改了计划：本版取代此前所有版本，接下来按它调整做法。',
  swallowed: '上下文刚被压缩，原先贴出的计划随之被压掉；这是同一版的重贴，不是新内容。',
  ledger: '上下文刚被压缩：计划没变，下面补上被压缩掉的用户原话。',
  cleared: '用户清空了计划（删掉了计划文件）：此前贴出的计划全部作废。若工作还没完，按用户最新的话重写一份。',
  orphan: '这个会话是从别的会话复制出来的（分支、换工作区等），对话里之前贴出的计划属于原会话，没能带过来。要接着用，先照它用 plan_write 写一份到本会话。',
}

function inheritedReason(plan) {
  const from = plan.inheritedFrom ?? {}
  return '这个会话是从别的会话复制出来的（分支、换工作区等，DSH 会给它一个新编号）。计划已从原会话'
    + (from.version ? '第 ' + from.version + ' 版' : '')
    + (from.exact === false ? '（原会话之后又改过，这是它的最新版）' : '')
    + '带过来，作为本会话第 1 版，接着用；之后的改动只记在本会话。'
}

export function renderPlanMessage({ plan, reason, refresh, ledger, ledgerOmitted, maxBytes, steps }) {
  const lines = ['## 你的计划（living plan）' + (plan.version ? ' 第 ' + plan.version + ' 版' : '')]
  const why = reason === 'refresh'
    ? '距上次贴出已 ' + steps + ' 步，重贴一次免得埋得太深；内容未变。'
    : reason === 'inherited' ? inheritedReason(plan) : REASONS[reason]
  lines.push('（' + why + '）')
  if (plan.exists && plan.text.trim() !== '') {
    const by = plan.updatedBy === 'user' ? '用户' : plan.updatedBy === 'agent' ? '你' : plan.updatedBy === 'inherited' ? '从原会话带来，' : '未知来源'
    lines.push('文件：' + plan.path + (plan.updatedAt ? ' · ' + by + '保存于 ' + plan.updatedAt : ''))
    const body = truncateUtf8(plan.text.trimEnd(), maxBytes)
    lines.push('', body.text)
    if (body.truncated) lines.push('', '［计划超过 ' + maxBytes + ' 字节，这里只到开头；plan_read 读全文。］')
  } else if (reason !== 'cleared' && reason !== 'orphan') {
    lines.push('还没有计划。')
  }
  if (ledger.length > 0) {
    lines.push('', '### 用户原话（被压缩掉的部分，逐字照录；压缩摘要是转述，以这里为准）')
    for (const entry of ledger) lines.push('', '〔' + stampOf(entry.time) + '〕', quoteLines(entry.shown))
    if (ledgerOmitted > 0) lines.push('', '（另有 ' + ledgerOmitted + ' 条较早的原话因篇幅省略。）')
  }
  if (refresh > 0) lines.push('', '［重贴 #' + refresh + '］')
  return lines.join('\n')
}

export function renderReminder(reminder, plan, quote, options = DEFAULTS) {
  if (reminder.kind === 'no-plan') {
    return [
      '## 计划提醒（living plan）',
      '已经 ' + reminder.steps + ' 步了，这个会话还没有计划。若这不是一次简单问答或小改动，先用 plan_write 写一份（模板见系统提示「你的计划」一节）；若是，忽略这条。',
    ].join('\n')
  }
  const cut = truncateUtf8(quote, options.quoteBytes)
  return [
    '## 计划提醒（living plan）',
    '用户在计划第 ' + plan.version + ' 版之后说：',
    quoteLines(cut.text + (cut.truncated ? '……' : '')),
    '',
    '之后已经过了 ' + reminder.steps + ' 步，计划还没动。如果这句话改了需求、做了拍板或否决了某条路线：先 plan_write——旧的需求或路线挪进「已作废」并写明是这次改的，新的拍板连原话写进「已定」——再接着做。没改就照计划继续，不用回应这条提醒。',
  ].join('\n')
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

// The same shape DSH's createUserMessage() builds: a fresh id and a frozen
// copy. The metadata under source.livingPlan is what applyEvent() reads back.
export function messageFor(text, livingPlan) {
  return deepFreeze(structuredClone({
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: KIND,
      form: 'snapshot',
      sections: [{ name: KIND, text }],
      livingPlan,
    },
    id: crypto.randomUUID(),
  }))
}
