// The DSH host half: a per-session living plan, injected into the system
// prompt at every assembly and changed only through plan_read / plan_write.
// The tool definitions are built here as plain ToolDefinitions so the plugin
// has no runtime dependency beyond the host services it injects.

import { PlanConflictError, PlanLimitError, PlanStore, resolveHome } from './core.js'

export const name = 'living-plan'
export const inject = ['tools', 'agents', 'systemPrompt']

const SECTION_NAME = 'living-plan:plan'
const SECTION_ORDER = 950

const GUIDE = [
  '你的计划是一份 Markdown 文件，路径在上方。用户也看得到，也可以直接改这个文件。',
  '',
  '它记录“现在工作在哪”，给下一个接手的人看：上下文被压缩后的你、子代理、以及用户。写清楚：',
  '- 这件事为了什么；',
  '- 按什么顺序做、为什么是这个顺序；',
  '- 已经定了什么（用户的拍板、否决的路线和原因）；',
  '- 做完的项和结果；',
  '- 每个未完成项是什么、在哪、怎样算完成。',
  '',
  '开工前自己写，不用等用户要求：超过一次问答或小改动的工作，先用 plan_write 写出计划，再按顺序做。',
  '工作推进就更新：完成一项、用户拍板、路线变了、发现后面依赖的东西。',
  '用 plan_write 整份替换；写之前如果用户可能刚改过，先 plan_read。每次保存自动成为下一版，旧版留在 history。',
  '若当前是 PTC 模式，在 run_code 里用 tools.plan_read / tools.plan_write；直接按工具名调用会被 PTC 拒绝。',
  '不要写成流水账：完成的步骤删掉过程只留结果，同一件事只写一处。',
  '不要为一次问答、小查看、小修写计划；一轮下来没有任何推进也不要改。',
  '',
  '如果用户先用 /plan 让你评审，评审通过后把同一份计划 plan_write 下来，再开始执行。',
].join('\n')

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

function stamp(plan) {
  if (!plan.version) return '当前：还没有计划'
  const by = plan.updatedBy === 'user' ? '用户或外部修改' : plan.updatedBy === 'agent' ? '你保存' : '未知来源'
  const at = plan.updatedAt ? ' ' + plan.updatedAt : ''
  return '当前：第 ' + plan.version + ' 版（' + by + at + '）'
}

function renderPrompt(plan, maxBytes) {
  const body = plan.text
    ? truncateUtf8(plan.text, maxBytes)
    : { text: '（还没有计划。超过一次问答或小改动的工作，先用 plan_write 写一份。）', truncated: false }
  const note = body.truncated
    ? '\n\n[计划超过 ' + maxBytes + ' 字节，这里只显示开头；plan_read 可以读全文。]'
    : ''
  return [
    '## 你的计划（living plan）',
    '',
    '文件：' + plan.path,
    stamp(plan),
    '',
    GUIDE,
    '',
    '### 当前计划',
    '',
    body.text + note,
  ].join('\n')
}

function unavailable(error) {
  return [
    '## 你的计划（living plan）',
    '',
    '计划文件现在读不了：' + (error?.message ?? String(error)),
    '',
    '仍然可以用 plan_read / plan_write；若它们也失败，把错误原样告诉用户，不要自己另建一份计划文件。',
  ].join('\n')
}

export function apply(ctx, config = {}) {
  const store = new PlanStore({
    home: config.home || resolveHome(),
    maxBytes: config.maxPlanBytes,
    historyLimit: config.historyLimit,
  })
  const includeSubagents = config.includeSubagents === true
  const order = Number.isFinite(config.sectionOrder) ? config.sectionOrder : SECTION_ORDER

  const allowed = (agent) => Boolean(agent) && (includeSubagents || agent.session?.header?.origin !== 'subagent')

  const promptFor = (agent) => {
    if (!allowed(agent)) return ''
    try {
      const plan = store.refresh(agent.id)
      // The text below is on screen for this request; the model has seen this
      // exact version, so a later plan_write may replace it unless the file
      // changes again first.
      store.markSeen(agent.id, plan.hash)
      return renderPrompt(plan, store.maxBytes)
    } catch (error) {
      return unavailable(error)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    if (!allowed(agent) || !agent.ctx?.systemPrompt) return
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      order,
      text: () => promptFor(agent),
    }), 'living-plan.section()')
  })

  // The Web panel reads the same store over one local route. The panel is
  // read-only: viewing a version never marks it seen for the model.
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const send = (status, value) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(value))
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, error: 'method-not-allowed' })
      if (!sessionId) return send(400, { ok: false, error: 'session-id-required' })
      let live = false
      try {
        live = webCtx.agents.get(sessionId) !== undefined
      } catch {
        live = false
      }
      if (!live) return send(404, { ok: false, error: 'session-not-live' })
      try {
        const requested = url.searchParams.get('version')
        if (requested !== null) {
          const version = Number(requested)
          const markdown = store.readVersion(sessionId, version)
          if (markdown === null) return send(404, { ok: false, error: 'version-not-found' })
          return send(200, {
            ok: true,
            value: { sessionId, version, markdown, historical: true, path: store.paths(sessionId).file },
          })
        }
        const plan = store.refresh(sessionId)
        return send(200, {
          ok: true,
          value: {
            sessionId,
            path: plan.path,
            exists: plan.exists,
            version: plan.version,
            bytes: plan.bytes,
            updatedAt: plan.updatedAt,
            updatedBy: plan.updatedBy,
            markdown: plan.text,
            historical: false,
            history: store.history(sessionId),
          },
        })
      } catch (error) {
        return send(500, { ok: false, error: error?.message ?? String(error) })
      }
    }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/api/living-plan',
      handler,
    }), 'living-plan.route()')
  })

  ctx.tools.register({
    name: 'plan_read',
    description: 'Read this session living plan and mark that version as seen. Read before plan_write when the user may have changed the plan. The plan file is also readable outside this tool, but only this tool updates the seen version.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          markdown: { type: 'string' },
          version: { type: 'integer' },
          bytes: { type: 'integer' },
          path: { type: 'string' },
          exists: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
        required: ['markdown', 'version', 'bytes', 'path', 'exists', 'truncated'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.exists
          ? 'Living plan v' + value.version + ' (' + value.bytes + ' bytes, ' + value.path + ')\n\n' + value.markdown
          : 'No living plan yet (' + value.path + '). Write one with plan_write before substantive work.')
          + (value.truncated ? '\n\n[truncated to the plan size limit]' : ''),
      }],
    },
    execute(_args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('plan_read requires an owning agent session')
      if (!allowed(agent)) throw new Error('this subagent session does not keep a living plan in this deployment')
      try {
        const plan = store.read(agent.id)
        const full = truncateUtf8(plan.text, store.maxBytes)
        return Promise.resolve({
          markdown: full.text,
          version: plan.version,
          bytes: plan.bytes,
          path: plan.path,
          exists: plan.exists,
          truncated: full.truncated,
        })
      } catch (error) {
        throw new Error(error?.message ?? String(error))
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read living plan', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'plan_write',
    description: 'Replace this session living plan with a complete Markdown document; each save becomes a new version. Use it before substantive work and whenever the work moves on. If the plan may have just been changed by the user, call plan_read first, otherwise this tool rejects the write.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        markdown: {
          type: 'string',
          description: 'The COMPLETE plan, replacing the previous version. Markdown, starting with a short # heading.',
        },
        note: {
          type: 'string',
          description: 'Optional short note for the version history index (not part of the plan).',
        },
      },
      required: ['markdown'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'integer' },
          bytes: { type: 'integer' },
          path: { type: 'string' },
        },
        required: ['version', 'bytes', 'path'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Saved living plan v' + value.version + ' (' + value.bytes + ' bytes, ' + value.path + ').',
      }],
    },
    execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('plan_write requires an owning agent session')
      if (!allowed(agent)) throw new Error('this subagent session does not keep a living plan in this deployment')
      if (!args || typeof args.markdown !== 'string') throw new Error('markdown is required and must be a string')
      try {
        const saved = store.write(agent.id, args.markdown, { seenHash: store.seenHash(agent.id) })
        if (typeof args.note === 'string' && args.note.trim() !== '') store.recordNote(agent.id, saved.version, args.note)
        return Promise.resolve({ version: saved.version, bytes: saved.bytes, path: saved.path })
      } catch (error) {
        if (error instanceof PlanConflictError || error instanceof PlanLimitError) throw new Error(error.message)
        throw error
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update living plan', kind: 'other', rawInput: args?.markdown }),
  })
}
