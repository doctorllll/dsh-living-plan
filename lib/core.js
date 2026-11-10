// Core of the living-plan store: one Markdown plan per session, a version
// history beside it, and detection of edits made outside the plan tools.
// No DSH imports here so the version/conflict rules stay unit-testable.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const EMPTY_HASH = sha256('')
export const DEFAULT_MAX_BYTES = 24576
export const DEFAULT_HISTORY_LIMIT = 50

export class PlanConflictError extends Error {
  constructor(message, version) {
    super(message)
    this.name = 'PlanConflictError'
    this.code = 'PLAN_STALE'
    this.version = version
  }
}

export class PlanLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlanLimitError'
    this.code = 'PLAN_LIMIT'
  }
}

export class PlanEditError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlanEditError'
    this.code = 'PLAN_EDIT'
  }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function resolveHome(home) {
  return home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function sessionDirName(sessionId) {
  const raw = String(sessionId ?? '')
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe.length <= 120) return safe || 'unnamed'
  return safe.slice(0, 100) + '-' + sha256(raw).slice(0, 16)
}

export function planPaths(home, sessionId) {
  const dir = path.join(resolveHome(home), 'living-plan', sessionDirName(sessionId))
  return {
    dir,
    file: path.join(dir, 'plan.md'),
    meta: path.join(dir, 'meta.json'),
    history: path.join(dir, 'history'),
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function readMeta(file) {
  const text = readText(file)
  if (text === null) return null
  try {
    const meta = JSON.parse(text)
    if (Number.isSafeInteger(meta?.version) && meta.version >= 0 && typeof meta?.hash === 'string') {
      return meta
    }
  } catch {
    // A damaged sidecar must not hide the plan itself; treat it as absent and
    // let the next refresh rebuild it from the file.
  }
  return null
}

function historyName(version) {
  return 'v' + String(version).padStart(4, '0') + '.md'
}

export class PlanStore {
  #home
  #maxBytes
  #historyLimit
  #seen = new Map()

  constructor(options = {}) {
    this.#home = resolveHome(options.home)
    this.#maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_MAX_BYTES
    this.#historyLimit = Number.isSafeInteger(options.historyLimit) && options.historyLimit >= 0
      ? options.historyLimit
      : DEFAULT_HISTORY_LIMIT
  }

  get home() {
    return this.#home
  }

  get maxBytes() {
    return this.#maxBytes
  }

  paths(sessionId) {
    return planPaths(this.#home, sessionId)
  }

  seenHash(sessionId) {
    return this.#seen.get(String(sessionId))
  }

  markSeen(sessionId, hash) {
    this.#seen.set(String(sessionId), hash)
  }

  /**
   * Read the current plan, and take an edit made outside the plan tools as the
   * next version (the user editing the file is a supported path, not tampering).
   */
  refresh(sessionId) {
    const id = String(sessionId)
    const paths = this.paths(id)
    let text = ''
    let exists = false
    try {
      const read = readText(paths.file)
      if (read !== null) {
        text = read
        exists = true
      }
    } catch (error) {
      throw new Error('cannot read the plan file: ' + (error?.message ?? String(error)))
    }
    const hash = sha256(text)
    let meta = readMeta(paths.meta)
    let external = false

    if (exists && meta === null) {
      // A plan left from before this store existed, or a first user edit.
      meta = {
        version: 1,
        hash,
        bytes: Buffer.byteLength(text, 'utf8'),
        updatedAt: new Date().toISOString(),
        updatedBy: 'user',
      }
      this.#archive(id, meta.version, text)
      atomicWrite(paths.meta, JSON.stringify(meta, null, 2) + '\n')
    } else if (exists && meta !== null && hash !== meta.hash) {
      external = true
      meta = this.#takeExternal(id, paths, meta, text, hash)
    } else if (!exists && meta !== null && meta.hash !== EMPTY_HASH) {
      // A deleted file is the user clearing the plan: keep the old text in
      // history and let the current plan be empty.
      external = true
      meta = this.#takeExternal(id, paths, meta, '', EMPTY_HASH)
    }

    if (meta === null) {
      meta = { version: 0, hash: EMPTY_HASH, bytes: 0, updatedAt: null, updatedBy: null }
    }

    return {
      sessionId: id,
      path: paths.file,
      historyDir: paths.history,
      exists,
      text,
      hash,
      version: meta.version,
      bytes: meta.bytes ?? Buffer.byteLength(text, 'utf8'),
      updatedAt: meta.updatedAt ?? null,
      updatedBy: meta.updatedBy ?? null,
      inheritedFrom: meta.inheritedFrom ?? null,
      external,
    }
  }

  /**
   * Seed a session that has no plan file with the plan of the session it was
   * copied from (DSH gives a branch, a moved session or a model switch that
   * starts a new session a new id). Takes the parent's version the
   * conversation actually showed — matched by hash — and falls back to the
   * parent's current plan. Returns the parent version used, or null.
   */
  inherit(sessionId, parentId, delivered = {}) {
    const id = String(sessionId)
    const parent = String(parentId ?? '')
    if (!parent || parent === id) return null
    // A session that ever had a plan of its own (even one the user cleared)
    // keeps it.
    if (readText(this.paths(id).file) !== null || readMeta(this.paths(id).meta) !== null) return null
    const source = this.paths(parent)
    const candidates = []
    if (Number.isSafeInteger(delivered.version) && delivered.version > 0) {
      candidates.push({ version: delivered.version, file: path.join(source.history, historyName(delivered.version)) })
    }
    for (const entry of this.history(parent)) {
      candidates.push({ version: entry.version, file: path.join(source.history, historyName(entry.version)) })
    }
    let found = null
    for (const candidate of candidates) {
      const text = readText(candidate.file)
      if (text !== null && text.trim() !== '' && (!delivered.hash || sha256(text) === delivered.hash)) {
        found = { version: candidate.version, text, exact: true }
        break
      }
    }
    if (found === null) {
      const current = readText(source.file)
      const meta = readMeta(source.meta)
      if (current === null || current.trim() === '') return null
      found = { version: meta?.version ?? 0, text: current, exact: !delivered.hash || sha256(current) === delivered.hash }
    }
    const paths = this.paths(id)
    const hash = sha256(found.text)
    const meta = {
      version: 1,
      hash,
      bytes: Buffer.byteLength(found.text, 'utf8'),
      updatedAt: new Date().toISOString(),
      updatedBy: 'inherited',
      inheritedFrom: { sessionId: parent, version: found.version, exact: found.exact },
    }
    this.#archive(id, 1, found.text)
    atomicWrite(paths.file, found.text)
    atomicWrite(paths.meta, JSON.stringify(meta, null, 2) + '\n')
    this.recordNote(id, 1, '继承自 ' + parent + ' 第 ' + found.version + ' 版')
    return meta.inheritedFrom
  }

  #takeExternal(sessionId, paths, previous, text, hash) {
    const version = previous.version + 1
    this.#archive(sessionId, version, text)
    const meta = {
      version,
      hash,
      bytes: Buffer.byteLength(text, 'utf8'),
      updatedAt: new Date().toISOString(),
      updatedBy: 'user',
    }
    atomicWrite(paths.meta, JSON.stringify(meta, null, 2) + '\n')
    return meta
  }

  read(sessionId) {
    const plan = this.refresh(sessionId)
    this.markSeen(sessionId, plan.hash)
    return plan
  }

  #normalize(markdown) {
    const text = markdown.endsWith('\n') ? markdown : markdown + '\n'
    if (text.trim() === '') throw new PlanLimitError('the plan is empty; write at least a heading and where the work stands')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.#maxBytes) {
      throw new PlanLimitError(
        'the plan is ' + bytes + ' bytes, over the ' + this.#maxBytes + '-byte limit; keep it to what a reader needs to carry on',
      )
    }
    return { text, bytes }
  }

  // The plan as it is now, refused when it is not the version the model saw.
  #fresh(id, options) {
    const current = this.refresh(id)
    const seen = options.seenHash ?? this.seenHash(id)
    if (seen !== current.hash) {
      throw new PlanConflictError(
        'the plan changed outside plan_write / plan_edit (now version ' + current.version + '); call plan_read and try again',
        current.version,
      )
    }
    return current
  }

  #save(id, { text, bytes }, current) {
    const paths = this.paths(id)
    const version = current.version + 1
    const hash = sha256(text)
    this.#archive(id, version, text)
    atomicWrite(paths.file, text)
    const meta = {
      version,
      hash,
      bytes,
      updatedAt: new Date().toISOString(),
      updatedBy: 'agent',
    }
    atomicWrite(paths.meta, JSON.stringify(meta, null, 2) + '\n')
    this.markSeen(id, hash)
    return {
      sessionId: id,
      path: paths.file,
      version,
      hash,
      bytes,
      updatedAt: meta.updatedAt,
    }
  }

  write(sessionId, markdown, options = {}) {
    const id = String(sessionId)
    if (typeof markdown !== 'string') throw new PlanLimitError('plan_write requires a Markdown string')
    const next = this.#normalize(markdown)
    return this.#save(id, next, this.#fresh(id, options))
  }

  /**
   * Replace passages of the plan and leave the rest as it is. Each
   * `old_string` must name one place in the plan as the edits before it left
   * it; all of them apply, as one new version, or none does.
   */
  edit(sessionId, edits, options = {}) {
    const id = String(sessionId)
    if (!Array.isArray(edits) || edits.length === 0) throw new PlanEditError('plan_edit requires at least one edit')
    const current = this.#fresh(id, options)
    if (!current.exists || current.text.trim() === '') {
      throw new PlanEditError('there is no plan yet; write one with plan_write')
    }
    let text = current.text
    edits.forEach((edit, index) => {
      const which = edits.length > 1 ? 'edit ' + (index + 1) + ': ' : ''
      if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
        throw new PlanEditError(which + 'old_string and new_string must be strings')
      }
      if (edit.old_string === '') throw new PlanEditError(which + 'old_string is empty; give the text to replace')
      if (edit.old_string === edit.new_string) throw new PlanEditError(which + 'old_string and new_string are the same')
      const found = text.split(edit.old_string).length - 1
      if (found === 0) {
        throw new PlanEditError(
          which + 'old_string is not in the plan' + (index > 0 ? ' as the edits before it left it' : '')
            + '; copy it exactly from the latest plan in the conversation, or call plan_read. Nothing was saved.',
        )
      }
      if (found > 1) {
        throw new PlanEditError(
          which + 'old_string is in the plan ' + found + ' times; include more of the text around it so it names one place. Nothing was saved.',
        )
      }
      text = text.replace(edit.old_string, () => edit.new_string)
    })
    return { ...this.#save(id, this.#normalize(text), current), edits: edits.length }
  }

  history(sessionId) {
    const dir = this.paths(sessionId).history
    let names
    try {
      names = fs.readdirSync(dir).filter((name) => /^v\d{4,}\.md$/.test(name))
    } catch {
      return []
    }
    return names
      .map((name) => {
        const version = Number(name.slice(1, -3))
        try {
          const stat = fs.statSync(path.join(dir, name))
          return { version, bytes: stat.size, at: stat.mtime.toISOString() }
        } catch {
          return null
        }
      })
      .filter((entry) => entry !== null)
      .sort((left, right) => right.version - left.version)
  }

  readVersion(sessionId, version) {
    if (!Number.isSafeInteger(version) || version < 1) return null
    const file = path.join(this.paths(sessionId).history, historyName(version))
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  recordNote(sessionId, version, note) {
    if (!note) return
    const paths = this.paths(sessionId)
    try {
      fs.mkdirSync(paths.history, { recursive: true, mode: 0o700 })
      fs.appendFileSync(
        path.join(paths.history, 'index.jsonl'),
        JSON.stringify({ version, note: String(note).slice(0, 500), at: new Date().toISOString() }) + '\n',
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch {
      // A missing note never blocks the plan itself.
    }
  }

  #archive(sessionId, version, text) {
    if (this.#historyLimit === 0) return
    const paths = planPaths(this.#home, sessionId || 'unnamed')
    try {
      fs.mkdirSync(paths.history, { recursive: true, mode: 0o700 })
      const file = path.join(paths.history, historyName(version))
      fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
      this.#prune(paths.history)
    } catch {
      // History is a convenience; never lose the plan because a copy failed.
    }
  }

  #prune(historyDir) {
    let names
    try {
      names = fs.readdirSync(historyDir).filter((name) => /^v\d{4,}\.md$/.test(name)).sort()
    } catch {
      return
    }
    const excess = names.length - this.#historyLimit
    if (excess <= 0) return
    for (const name of names.slice(0, excess)) {
      try {
        fs.unlinkSync(path.join(historyDir, name))
      } catch {
        // Leave an undeletable old version in place.
      }
    }
  }
}
