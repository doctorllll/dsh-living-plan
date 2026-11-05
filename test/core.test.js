import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EMPTY_HASH, PlanConflictError, PlanLimitError, PlanStore, planPaths } from '../lib/core.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'living-plan-'))
}

test('starts empty and writes version 1', () => {
  const store = new PlanStore({ home: tempHome() })
  const initial = store.refresh('s1')
  assert.equal(initial.version, 0)
  assert.equal(initial.exists, false)
  assert.equal(initial.hash, EMPTY_HASH)

  store.markSeen('s1', initial.hash)
  const saved = store.write('s1', '# Plan\n\n- [ ] first step')
  assert.equal(saved.version, 1)
  assert.equal(fs.readFileSync(saved.path, 'utf8'), '# Plan\n\n- [ ] first step\n')
  assert.ok(fs.existsSync(path.join(store.paths('s1').history, 'v0001.md')))
  const meta = JSON.parse(fs.readFileSync(store.paths('s1').meta, 'utf8'))
  assert.equal(meta.version, 1)
  assert.equal(meta.updatedBy, 'agent')
})

test('whole replacement becomes the next version', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('s1', EMPTY_HASH)
  store.write('s1', '# Plan\n\nv1'  )
  const saved = store.write('s1', '# Plan\n\nv2')
  assert.equal(saved.version, 2)
  assert.equal(store.refresh('s1').text, '# Plan\n\nv2\n')
})

test('an external edit is a version and a stale write conflicts', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('s1', EMPTY_HASH)
  store.write('s1', '# Plan\n\nv1')
  const paths = planPaths(store.home, 's1')
  fs.writeFileSync(paths.file, '# Plan\n\nuser changed this\n')

  const seen = store.refresh('s1')
  assert.equal(seen.version, 2)
  assert.equal(seen.updatedBy, 'user')
  assert.equal(seen.external, true)

  assert.throws(
    () => store.write('s1', '# Plan\n\nagent overwrite'),
    (error) => error instanceof PlanConflictError && error.version === 2,
  )

  store.read('s1')
  const saved = store.write('s1', '# Plan\n\nagent overwrite')
  assert.equal(saved.version, 3)
  assert.equal(fs.readFileSync(paths.file, 'utf8'), '# Plan\n\nagent overwrite\n')
})

test('deleting the file clears the plan as a new version', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('s1', EMPTY_HASH)
  store.write('s1', '# Plan\n\nv1')
  fs.unlinkSync(planPaths(store.home, 's1').file)
  const plan = store.refresh('s1')
  assert.equal(plan.version, 2)
  assert.equal(plan.text, '')
  assert.equal(plan.exists, false)
  assert.equal(plan.updatedBy, 'user')
})

test('rejects an oversized plan', () => {
  const store = new PlanStore({ home: tempHome(), maxBytes: 64 })
  store.markSeen('s1', EMPTY_HASH)
  assert.throws(() => store.write('s1', '# Plan\n' + 'x'.repeat(100)), PlanLimitError)
})

test('rejects an empty plan', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('s1', EMPTY_HASH)
  assert.throws(() => store.write('s1', '   '), PlanLimitError)
})

test('keeps only the configured history window', () => {
  const store = new PlanStore({ home: tempHome(), historyLimit: 2 })
  store.markSeen('s1', EMPTY_HASH)
  for (let i = 1; i <= 4; i += 1) store.write('s1', '# Plan\n\nv' + i)
  const names = fs.readdirSync(store.paths('s1').history).filter((name) => name.endsWith('.md')).sort()
  assert.deepEqual(names, ['v0003.md', 'v0004.md'])
})

test('notes go to the history index', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('s1', EMPTY_HASH)
  const saved = store.write('s1', '# Plan\n\nv1')
  store.recordNote('s1', saved.version, 'first sketch')
  const index = fs.readFileSync(path.join(store.paths('s1').history, 'index.jsonl'), 'utf8')
  assert.match(index, /first sketch/)
})

test('separate sessions do not share a plan', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('a', EMPTY_HASH)
  store.write('a', '# A\n')
  assert.equal(store.refresh('b').version, 0)
  assert.notEqual(store.refresh('a').path, store.refresh('b').path)
})
