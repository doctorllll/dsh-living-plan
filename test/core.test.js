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

test('history lists newest first and readVersion returns a copy', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('s1', EMPTY_HASH)
  store.write('s1', '# Plan\n\nv1')
  store.write('s1', '# Plan\n\nv2')
  const history = store.history('s1')
  assert.deepEqual(history.map((entry) => entry.version), [2, 1])
  assert.equal(store.readVersion('s1', 1), '# Plan\n\nv1\n')
  assert.equal(store.readVersion('s1', 99), null)
})

test('separate sessions do not share a plan', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('a', EMPTY_HASH)
  store.write('a', '# A\n')
  assert.equal(store.refresh('b').version, 0)
  assert.notEqual(store.refresh('a').path, store.refresh('b').path)
})

test('client bundle uses the Web module loader and Node-free imports', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /^window\.__ModuleLoader__\.load\(/)
  assert.match(source, /exports\.apply = apply/)
  assert.match(source, /require\("react"\)/)
  assert.doesNotMatch(source, /require\("node:/)
  assert.doesNotMatch(source, /from "node:/)
})

test('a copied session inherits the parent version it showed', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('parent', EMPTY_HASH)
  store.write('parent', '# Plan\n\nv1')
  const shown = store.write('parent', '# Plan\n\nv2')
  store.write('parent', '# Plan\n\nv3 after the branch')
  const from = store.inherit('child', 'parent', { version: shown.version, hash: shown.hash })
  assert.deepEqual(from, { sessionId: 'parent', version: 2, exact: true })
  const child = store.refresh('child')
  assert.equal(child.version, 1)
  assert.equal(child.text, '# Plan\n\nv2\n')
  assert.equal(child.updatedBy, 'inherited')
  assert.deepEqual(child.inheritedFrom, from)
  // Only once, and never over a plan of its own.
  assert.equal(store.inherit('child', 'parent', { version: 3 }), null)
})

test('inheritance falls back to the parent current plan, and gives up without one', () => {
  const store = new PlanStore({ home: tempHome() })
  store.markSeen('parent', EMPTY_HASH)
  store.write('parent', '# Plan\n\nnow')
  const from = store.inherit('child', 'parent', { version: 9, hash: 'not-there' })
  assert.deepEqual(from, { sessionId: 'parent', version: 1, exact: false })
  assert.equal(store.inherit('orphan', 'missing-parent', { version: 1, hash: 'x' }), null)
  assert.equal(store.refresh('orphan').exists, false)
})
