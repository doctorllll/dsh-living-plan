// The DSH host half: a per-session living plan, changed only through
// plan_read / plan_write (or by the user editing the file).
//
// The plan reaches the model as a message in the conversation, not as system
// prompt text, so saving a new version never rewrites the cached prompt
// prefix. A step posts it when there is a new version, when a compaction
// swallowed the last copy, or when the last copy is many steps back; the
// user's own words a compaction replaced ride along verbatim. `placement:
// system` restores the old behaviour (plan text in the system prompt).

import { EMPTY_HASH, PlanConflictError, PlanLimitError, PlanStore, planHints, resolveHome } from './core.js'
import { DEFAULTS, decide, ledgerEntries, messageFor, messageText, projection, renderPlanMessage, renderReminder, truncateUtf8 } from './deliver.js'

export const name = 'living-plan'
export const inject = ['tools', 'agents', 'systemPrompt', 'sessionProjections']

const SECTION_NAME = 'living-plan:plan'
const SECTION_ORDER = 950

const GUIDE = [
  '它记录"现在工作在哪"，给接手的人看：上下文被压缩后的你、子代理、以及用户。按这个骨架写：',
  '',
  '```markdown',
  '# 几个字的标题',
  '> 用户的原话（开头那句需求原样引用，不转述）',
  '',
  '## 目标与验收',
  '为了什么；怎样算完成（能逐条检查的标准）。',
  '## 已定',
  '用户拍板的事，附原话和日期；否决的路线和原因。',
  '## 已作废',
  '被用户改掉的需求或路线：原来是什么、哪次改的。',
  '## 进度',
  '- [x] 做完的（只留结果）',
  '- [ ] 没做的：是什么、在哪、怎样算完成',
  '## 下一步',
  '```',
  '',
  '开工前自己写，不用等用户要求：超过一次问答或小改动的工作，先用 plan_write 写出计划，再按顺序做。',
  '工作推进就更新：完成一项、用户拍板、路线变了、发现后面依赖的东西。',
  '用户最新的话优先于计划里的旧内容。用户改口时先改计划再动手：旧的挪进「已作废」，新的连原话写进「已定」。',
  '收工前逐条对照「目标与验收」，没满足的不说完成。',
  '用 plan_write 整份替换；用户可能刚改过时先 plan_read。每次保存自动成为下一版，旧版留在 history。',
  '若当前是 PTC 模式，在 run_code 里用 tools.plan_read / tools.plan_write；直接按工具名调用会被 PTC 拒绝。',
  '不要写成流水账：完成的步骤删掉过程只留结果，同一件事只写一处。',
  '不要为一次问答、小查看、小修写计划；一轮下来没有任何推进也不要改。',
  '',
  '如果用户先用 /plan 让你评审，评审通过后把同一份计划 plan_write 下来，再开始执行。',
].join('\n')

const DELIVERY = [
  '计划正文不在这里：它以「你的计划（living plan）」消息出现在对话里。保存后的下一步贴出新版，上下文被压缩后自动重贴，隔一段也会重贴；以对话里最新的一份为准。',
  '压缩会把用户早先的话换成转述，那时计划消息后面会附「用户原话」逐字原文，照原话理解用户要什么。',
  '看到「计划提醒」消息时，按它说的检查一遍再继续。',
].join('\n')

function stamp(plan) {
  if (!plan.version) return '当前：还没有计划'
  const by = plan.updatedBy === 'user' ? '用户或外部修改' : plan.updatedBy === 'agent' ? '你保存' : '未知来源'
  const at = plan.updatedAt ? ' ' + plan.updatedAt : ''
  return '当前：第 ' + plan.version + ' 版（' + by + at + '）'
}

// placement: message — fixed text, so the prompt prefix stays put.
function renderGuide(path) {
  return ['## 你的计划（living plan）', '', '计划文件：' + path + '。用户看得到，也可以直接改它。', '', GUIDE, '', DELIVERY].join('\n')
}

// placement: system — the pre-0.3 prompt, plan text included.
function renderSystemPlan(plan, maxBytes) {
  const body = plan.text
    ? truncateUtf8(plan.text, maxBytes)
    : { text: '（还没有计划。超过一次问答或小改动的工作，先用 plan_write 写一份。）', truncated: false }
  const note = body.truncated
    ? '\n\n[计划超过 ' + maxBytes + ' 字节，这里只显示开头；plan_read 可以读全文。]'
    : ''
  return [
    '## 你的计划（living plan）',
    '',
    '计划文件：' + plan.path + '。用户看得到，也可以直接改它。',
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

function count(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function readUser(session, seq) {
  try {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') return null
    return { text: messageText(event.data), time: event.time }
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const store = new PlanStore({
    home: config.home || resolveHome(),
    maxBytes: config.maxPlanBytes,
    historyLimit: config.historyLimit,
  })
  const includeSubagents = config.includeSubagents === true
  const order = Number.isFinite(config.sectionOrder) ? config.sectionOrder : SECTION_ORDER
  // Posting needs the session projection; if it cannot run, the plan falls
  // back into the system prompt rather than going missing.
  let delivering = config.placement !== 'system'
  const fallBack = (why) => {
    if (!delivering) return
    delivering = false
    ctx.logger?.warn?.('living-plan: posting disabled, plan goes into the system prompt: %s', why?.message ?? why)
  }
  const options = {
    refreshSteps: count(config.refreshSteps, DEFAULTS.refreshSteps),
    remindAfterSteps: count(config.remindAfterSteps, DEFAULTS.remindAfterSteps),
    noPlanAfterSteps: count(config.noPlanAfterSteps, DEFAULTS.noPlanAfterSteps),
    ledgerMaxBytes: count(config.ledgerMaxBytes, DEFAULTS.ledgerMaxBytes),
    ledgerFirstBytes: DEFAULTS.ledgerFirstBytes,
    ledgerEachBytes: DEFAULTS.ledgerEachBytes,
    quoteBytes: DEFAULTS.quoteBytes,
  }

  const allowed = (agent) => Boolean(agent) && (includeSubagents || agent.session?.header?.origin !== 'subagent')

  const promptFor = (agent) => {
    if (!allowed(agent)) return ''
    try {
      if (delivering) return renderGuide(store.paths(agent.id).file)
      const plan = store.refresh(agent.id)
      // The text below is on screen for this request, so a later plan_write
      // may replace this version unless the file changes again first.
      store.markSeen(agent.id, plan.hash)
      return renderSystemPlan(plan, store.maxBytes)
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

  // What the conversation already holds is folded from the session log, so it
  // survives restarts; the step decides what to post from it and the file.
  const ready = ctx.sessionProjections.register(projection)
  ready.then(undefined, fallBack)

  ctx.on('agent/pre-step', async (args, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || args.signal?.aborted) return decision
    const agent = args.agent
    if (!allowed(agent) || !agent.session) return decision
    try {
      const handle = await ready
      let plan = store.refresh(agent.id)
      const state = handle.stateOf(agent.session)
      const choice = decide(state, plan, agent.id, { ...options, deliver: delivering })
      if (choice.parent !== null && store.inherit(agent.id, choice.parent.sessionId, choice.parent) !== null) {
        // A copied session carries its parent's plan instead of starting over.
        plan = store.refresh(agent.id)
        choice.reason = delivering ? 'inherited' : null
      }
      const hasPlan = plan.exists && plan.text.trim() !== ''
      const posted = []
      if (choice.reason !== null) {
        const ledger = ledgerEntries(choice.ledgerSeqs, state.users[0], (seq) => readUser(agent.session, seq), options)
        const text = renderPlanMessage({
          plan,
          reason: choice.reason,
          refresh: choice.refresh,
          ledger: ledger.entries,
          ledgerOmitted: ledger.omitted,
          maxBytes: store.maxBytes,
          steps: state.delivered?.steps ?? 0,
        })
        posted.push(messageFor(text, {
          form: 'plan',
          sessionId: String(agent.id),
          hash: hasPlan ? plan.hash : EMPTY_HASH,
          version: plan.version,
          ledger: choice.ledgerSeqs.length,
          refresh: choice.refresh,
        }))
      }
      // What the model now holds is the current version — or, with no plan
      // file, the knowledge that there is none — so plan_write may replace it.
      if (choice.reason !== null || choice.holdsCurrent || !plan.exists) store.markSeen(agent.id, plan.hash)
      if (choice.reminder !== null) {
        const quote = choice.reminder.kind === 'changed' ? readUser(agent.session, choice.reminder.seq)?.text ?? '' : ''
        posted.push(messageFor(renderReminder(choice.reminder, plan, quote, options), {
          form: 'reminder',
          sessionId: String(agent.id),
          remindedFor: choice.reminder.kind === 'changed' ? choice.reminder.seq : null,
          noPlan: choice.reminder.kind === 'no-plan',
        }))
      }
      if (posted.length === 0) return decision
      // After this step's own input, where DSH puts its other context
      // snapshots, so the turn's user message stays the turn's first message.
      return { ...decision, messages: [...decision.messages, ...posted] }
    } catch (error) {
      // The plan must never stop the agent, nor go missing: this step goes
      // without a post, and from the next request on the plan is back in the
      // system prompt.
      fallBack(error)
      return decision
    }
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
    description: 'Replace this session living plan with a complete Markdown document; each save becomes a new version. Use it before substantive work and whenever the work moves on, and first of all when the user changes what they want. If the plan may have just been changed by the user, call plan_read first, otherwise this tool rejects the write.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        markdown: {
          type: 'string',
          description: 'The COMPLETE plan, replacing the previous version. Markdown, starting with a short # heading, then the user\'s own words quoted with >.',
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
          hints: { type: 'array', items: { type: 'string' } },
        },
        required: ['version', 'bytes', 'path'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Saved living plan v' + value.version + ' (' + value.bytes + ' bytes, ' + value.path + ').'
          + (Array.isArray(value.hints) && value.hints.length > 0
            ? '\n\n已保存。下次更新时补上：\n- ' + value.hints.join('\n- ')
            : ''),
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
        const hints = planHints(args.markdown)
        return Promise.resolve({ version: saved.version, bytes: saved.bytes, path: saved.path, ...(hints.length > 0 ? { hints } : {}) })
      } catch (error) {
        if (error instanceof PlanConflictError || error instanceof PlanLimitError) throw new Error(error.message)
        throw error
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Update living plan', kind: 'other', rawInput: args?.markdown }),
  })
}
