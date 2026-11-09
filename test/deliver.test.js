import assert from 'node:assert/strict'
import test from 'node:test'

import { EMPTY_HASH, planHints } from '../lib/core.js'
import { DEFAULTS, KIND, applyEvent, decide, initialState, ledgerEntries, messageFor, projection, renderPlanMessage, renderReminder } from '../lib/deliver.js'

const SID = 'session-a'

function fold(events, state = initialState()) {
  return events.reduce((acc, event) => applyEvent(acc, event), state)
}

const user = (seq, text = 'hello', time = 1000 + seq) => ({ type: 'user/message', seq, time, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
const step = (seq) => ({ type: 'step/start', seq, time: 0, data: {} })
const posted = (seq, note) => ({ type: 'user/message', seq, time: 0, surfaceOp: 'append', data: messageFor('plan', note) })
const compaction = (seq, shadowed) => ({
  type: 'user/message', seq, time: 0,
  surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
  sourceEventSeqs: [seq - 2, seq - 1, ...shadowed],
  data: { role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint' } },
})
const plan = (overrides = {}) => ({ exists: true, text: '# P\n', hash: 'h1', version: 1, updatedAt: new Date(5000).toISOString(), updatedBy: 'agent', path: '/x/plan.md', ...overrides })
const none = { exists: false, text: '', hash: EMPTY_HASH, version: 0, updatedAt: null, updatedBy: null, path: '/x/plan.md' }

test('unrelated events keep the same state object', () => {
  const state = initialState()
  assert.equal(applyEvent(state, { type: 'tool/result', seq: 1, time: 0, surfaceOp: 'append', data: {} }), state)
  assert.equal(applyEvent(state, { type: 'user/message', seq: 2, time: 0, surfaceOp: 'append', data: { source: { kind: 'time-context' } } }), state)
  assert.equal(projection.stateSchema.parse(state), state)
  assert.throws(() => projection.stateSchema.parse({ users: 'x' }))
})

test('folds user words, steps and its own deliveries', () => {
  const state = fold([user(1), step(2), posted(3, { form: 'plan', sessionId: SID, hash: 'h1', version: 1, ledger: 0, refresh: 0 }), step(4), step(5)])
  assert.deepEqual(state.users, [1])
  assert.equal(state.steps, 3)
  assert.equal(state.lastUser.steps, 3)
  assert.equal(state.delivered.seq, 3)
  assert.equal(state.delivered.steps, 2)
  assert.equal(state.delivered.swallowed, false)
})

test('a compaction swallows the delivered plan and the user words it replaced', () => {
  const state = fold([user(1, 'first ask'), posted(2, { form: 'plan', sessionId: SID, hash: 'h1', version: 1, ledger: 0, refresh: 0 }), user(3, 'change'), compaction(10, [1, 2, 3])])
  assert.equal(state.delivered.swallowed, true)
  assert.deepEqual(state.swallowed, [1, 3])
  // A system prompt rewrite is a replacement too, but loses no user words.
  const other = applyEvent(fold([user(1)]), { type: 'system/message', seq: 4, time: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [1], data: {} })
  assert.deepEqual(other.swallowed, [])
})

test('posts the plan once, then again only for a new version, a swallow, a ledger or a refresh', () => {
  const opts = { ...DEFAULTS, refreshSteps: 3 }
  assert.equal(decide(initialState(), plan(), SID, opts).reason, 'first')
  let state = fold([posted(1, { form: 'plan', sessionId: SID, hash: 'h1', version: 1, ledger: 0, refresh: 0 })])
  let choice = decide(state, plan(), SID, opts)
  assert.equal(choice.reason, null)
  assert.equal(choice.holdsCurrent, true)
  assert.equal(decide(state, plan({ hash: 'h2', version: 2 }), SID, opts).reason, 'new')
  assert.equal(decide(state, plan({ hash: 'h2', version: 2, updatedBy: 'user' }), SID, opts).reason, 'user')
  state = fold([step(2), step(3), step(4)], state)
  choice = decide(state, plan(), SID, opts)
  assert.equal(choice.reason, 'refresh')
  assert.equal(choice.refresh, 1)
  state = fold([user(5, 'ask'), compaction(9, [1, 5])], state)
  choice = decide(state, plan(), SID, opts)
  assert.equal(choice.reason, 'swallowed')
  assert.deepEqual(choice.ledgerSeqs, [5])
  state = fold([posted(10, { form: 'plan', sessionId: SID, hash: 'h1', version: 1, ledger: 1, refresh: 0 })], state)
  assert.equal(decide(state, plan(), SID, opts).reason, null)
})

test('a fork does not count its parent delivery as its own', () => {
  const state = fold([posted(1, { form: 'plan', sessionId: 'parent', hash: 'h1', version: 1, ledger: 0, refresh: 0 })])
  assert.equal(decide(state, plan(), SID).reason, 'first')
  assert.equal(decide(state, none, SID).reason, null)
})

test('a deleted plan file is announced once', () => {
  let state = fold([posted(1, { form: 'plan', sessionId: SID, hash: 'h1', version: 1, ledger: 0, refresh: 0 })])
  assert.equal(decide(state, { ...none, version: 2 }, SID).reason, 'cleared')
  state = fold([posted(2, { form: 'plan', sessionId: SID, hash: EMPTY_HASH, version: 2, ledger: 0, refresh: 0 })], state)
  assert.equal(decide(state, { ...none, version: 2 }, SID).reason, null)
})

test('reminds once when the user spoke after the plan and it did not move', () => {
  const base = [posted(1, { form: 'plan', sessionId: SID, hash: 'h1', version: 1, ledger: 0, refresh: 0 }), user(2, '改成 B', 9000)]
  let state = fold([...base, step(3), step(4)])
  assert.equal(decide(state, plan(), SID).reminder, null)
  state = fold([step(5)], state)
  const choice = decide(state, plan(), SID)
  assert.deepEqual(choice.reminder, { kind: 'changed', seq: 2, steps: 3 })
  // Updated after the message: nothing to remind.
  assert.equal(decide(state, plan({ hash: 'h2', version: 2, updatedAt: new Date(9500).toISOString() }), SID).reminder, null)
  state = fold([{ type: 'user/message', seq: 6, time: 0, surfaceOp: 'append', data: messageFor('r', { form: 'reminder', remindedFor: 2, noPlan: false }) }], state)
  assert.equal(decide(state, plan(), SID).reminder, null)
})

test('reminds once when a long session has no plan', () => {
  let state = fold([user(1), ...Array.from({ length: 8 }, (_, i) => step(2 + i))])
  assert.equal(decide(state, none, SID).reminder.kind, 'no-plan')
  state = fold([{ type: 'user/message', seq: 20, time: 0, surfaceOp: 'append', data: messageFor('r', { form: 'reminder', remindedFor: null, noPlan: true }) }], state)
  assert.equal(decide(state, none, SID).reminder, null)
})

test('placement: system posts nothing but still reminds', () => {
  const state = fold([user(1, 'x', 9000), step(2), step(3), step(4)])
  const choice = decide(state, plan(), SID, { ...DEFAULTS, deliver: false })
  assert.equal(choice.reason, null)
  assert.equal(choice.reminder.kind, 'changed')
})

test('the ledger keeps the first ask and the newest words within budget', () => {
  const texts = { 1: '最初的需求'.repeat(10), 2: 'b'.repeat(400), 3: 'c'.repeat(400), 4: 'd'.repeat(400) }
  const read = (seq) => ({ text: texts[seq], time: 0 })
  const { entries, omitted } = ledgerEntries([1, 2, 3, 4], 1, read, { ...DEFAULTS, ledgerMaxBytes: 1100, ledgerEachBytes: 640 })
  assert.deepEqual(entries.map((entry) => entry.seq), [1, 3, 4])
  assert.equal(omitted, 1)
  assert.match(entries[0].shown, /^最初的需求/)
})

test('rendered messages carry the version, the verbatim words and the reminder quote', () => {
  const text = renderPlanMessage({ plan: plan({ version: 3 }), reason: 'swallowed', refresh: 0, ledger: [{ seq: 1, time: 0, shown: '用户说的原话' }], ledgerOmitted: 2, maxBytes: 24576, steps: 0 })
  assert.match(text, /第 3 版/)
  assert.match(text, /同一版的重贴/)
  assert.match(text, /> 用户说的原话/)
  assert.match(text, /另有 2 条/)
  const reminder = renderReminder({ kind: 'changed', seq: 2, steps: 3 }, plan({ version: 3 }), '改成 B')
  assert.match(reminder, /第 3 版之后/)
  assert.match(reminder, /> 改成 B/)
  assert.match(reminder, /已作废/)
})

test('posted messages look like DSH user messages', () => {
  const message = messageFor('hi', { form: 'plan' })
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, KIND)
  assert.equal(typeof message.id, 'string')
  assert.ok(Object.isFrozen(message.source))
})

test('plan hints ask for the user quote and acceptance', () => {
  assert.equal(planHints('# P\n> 用户原话\n## 目标与验收\n- x').length, 0)
  assert.equal(planHints('# P\n- x').length, 2)
})
