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
      external,
    }
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

  write(sessionId, markdown, options = {}) {
    const id = String(sessionId)
    if (typeof markdown !== 'string') throw new PlanLimitError('plan_write requires a Markdown string')
    const text = markdown.endsWith('\n') ? markdown : markdown + '\n'
    if (text.trim() === '') throw new PlanLimitError('the plan is empty; write at least a heading and where the work stands')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.#maxBytes) {
      throw new PlanLimitError(
        'the plan is ' + bytes + ' bytes, over the ' + this.#maxBytes + '-byte limit; keep it to what a reader needs to carry on',
      )
    }

    const current = this.refresh(id)
    const seen = options.seenHash ?? this.seenHash(id)
    if (seen !== current.hash) {
      throw new PlanConflictError(
        'the plan changed outside plan_write (now version ' + current.version + '); call plan_read and write again',
        current.version,
      )
    }

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
