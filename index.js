/**
 * dsh-provider-router — host half.
 *
 * No virtual route, no selector entries: the plugin exists to let the model
 * running a conversation borrow third-party models of OTHER attached providers,
 * as many times as it likes, in whatever batches it decides (P→C1, P→C2,
 * P→C1+C3…), through one agent tool: `router_call`.
 *
 *   1. The settings page holds the callable list: every model the attached
 *      providers advertise, one checkbox per model, hot-editable.
 *   2. `router_call(task, materials?, targets?)` fans out in parallel to the
 *      checked models (minus the model the conversation itself runs on),
 *      feeding each only the task and the given materials — the same shape as
 *      calling a model from a script: input information → the model → packages
 *      of returned content. Repeated calls are the norm; each call's scope is
 *      chosen by the parent.
 *   3. Each model carries a manually maintained remaining-token quota
 *      (negative = unlimited, one-click reset). Dispatch consults it before
 *      spending; every verdict reports this call's tokens and the remaining
 *      balance so the parent can size subtasks against real budgets.
 *
 * Rules of implementation:
 *   - Registrations are effects owned by this context; teardown releases them.
 *   - Config lives in a schemastery Config with volatile rows, so the Settings
 *     panel's writes land in this same live object without remounting us.
 *   - The router never speaks a wire protocol: credentials, endpoints,
 *     compatibility switches and retry policies stay where they are; we only
 *     delegate to target adapters and fold their chunks back to text.
 *   - schemastery + cosmokit are vendored (vendor/) because this bundle resolves
 *     outside the profile tree, where bare imports cannot be resolved.
 */
import z from './vendor/schemastery.mjs'
import { readFileSync } from 'node:fs'

export const name = 'dsh-provider-router'

/** Seams used: llm = stream API; tools = agent tool registry. */
export const inject = ['llm', 'tools']

/** Settings namespace shared with the browser half (the section id). */
const NS = 'provider-router'
/** Wildcard: every model the source provider advertises. */
const WILDCARD = '*'
/** Separator between source provider and model inside a virtual id. */
const SEP = '::'
/** Per-target wall clock: one slow model fails ITSELF with a timeout verdict,
 * never stalling the whole parallel batch (the outer policy budget is much larger). */
const TARGET_TIMEOUT_MS = 120_000

/**
 * Plugin config. `routes` is volatile: the Settings panel writes it, the
 * loader commits into this same object, and tool dispatch reads it live.
 */
export const Config = z.object({
  /**
   * Callable third-party models, per attached provider. An exact `model`
   * entry decides that model; a `"*"` entry marks the whole source checked.
   * `quota` is the manually maintained remaining-token budget (negative =
   * unlimited); `label` is optional, unused today but kept for selectors.
   */
  routes: z.array(z.object({
    /** Attached provider route owning the model (the real upstream). */
    source: z.string().required(),
    /** Exact model id under that provider, or "*" for every model it lists. */
    model: z.string().required(),
    /** Optional selector label override; defaults to the upstream display name. */
    label: z.string(),
    /** Master switch; false keeps this entry out of every fan-out. */
    enabled: z.boolean().default(true),
    /** Remaining tokens for this model; negative = unlimited. Consumed at call time. */
    quota: z.number().default(-1).description('Remaining tokens; negative means unlimited'),
  }))
    .default([])
    .volatile()
    .description('Callable models and their remaining-token budgets'),
})

/**
 * Read the route table defensively.
 */
function liveRoutes(config) {
  const field = config?.routes
  const raw = typeof field?.get === 'function' ? field.get() : field
  const rows = Array.isArray(raw) ? raw : []
  const routes = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const source = typeof row.source === 'string' ? row.source.trim() : ''
    const model = typeof row.model === 'string' ? row.model.trim() : ''
    if (source === '' || model === '') continue
    routes.push({
      source,
      model,
      label: typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : undefined,
      enabled: row.enabled !== false,
      quota: typeof row.quota === 'number' && Number.isFinite(row.quota) ? row.quota : -1,
    })
  }
  return routes
}

/** Profile directory holding the patch document both halves share. */
function profileDir() {
  return process.env.DSH_PROFILE_DIR
    ?? `${process.env.DSH_HOME ?? ''}/profiles/${process.env.DSH_PROFILE ?? ''}`
}

/** Scalar YAML value: quotes off, bool/int typed, star kept as text. */
function yamlScalar(v) {
  const t = String(v ?? '').trim()
  if (t === '') return undefined
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  return t.replace(/^['"]|['"]$/g, '')
}

/**
 * Minimal reader for the provider-router row of the profile patch.
 *
 * The Settings panel and hand edits write the SAME document; when the volatile
 * bridge momentarily presents an empty table (observed after row toggles),
 * this reads the durable source instead. It understands only our row shape:
 * a top-level `- id: provider-router` map whose `config.routes` is a list of
 * flat scalar entries — deliberately not a general YAML parser.
 */
function routesFromProfile() {
  let text
  try {
    text = readFileSync(`${profileDir()}/cordis.patch.yml`, 'utf8')
  } catch {
    return []
  }
  const lines = text.split(/\r?\n/)
  // Last occurrence wins, mirroring Loader composition order.
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s+id:\s*provider-router\b/.test(lines[i])) start = i
  }
  if (start === -1) return []
  // Block runs until the next top-level row.
  const block = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) break
    block.push(lines[i])
  }
  const routesAt = block.findIndex(l => /^\s*routes:\s*$/.test(l))
  if (routesAt === -1) return []

  const records = []
  let current = null
  for (let i = routesAt + 1; i < block.length; i++) {
    const l = block[i]
    if (/^\s*$/.test(l)) continue
    const item = l.match(/^\s*- (.+?):\s*(.*)$/)
    if (item !== null) {
      if (current !== null) records.push(current)
      current = { source: undefined, model: undefined, label: undefined, enabled: undefined, quota: undefined }
      applyKey(current, item[1].trim(), item[2])
      continue
    }
    const keyLine = l.match(/^\s{2,}([A-Za-z*]+):\s*(.*)$/)
    if (keyLine !== null && current !== null) {
      if (!['source', 'model', 'enabled', 'quota', 'label'].includes(keyLine[1])) break
      applyKey(current, keyLine[1], keyLine[2])
      continue
    }
    break // left our routes list (deeper indent or sibling key)
  }
  if (current !== null) records.push(current)

  const routes = []
  for (const r of records) {
    if (typeof r.source !== 'string' || r.source === '') continue
    if (typeof r.model !== 'string' || r.model === '') continue
    routes.push({
      source: r.source,
      model: r.model,
      label: typeof r.label === 'string' && r.label !== '' ? r.label : undefined,
      enabled: r.enabled !== false,
      quota: typeof r.quota === 'number' ? r.quota : -1,
    })
  }
  return routes
}

/** Assign one parsed key onto a record, keeping the typed value. */
function applyKey(record, key, rawValue) {
  if (key === 'source' || key === 'model' || key === 'label') {
    record[key] = yamlScalar(rawValue) ?? ''
  } else if (key === 'enabled') {
    record.enabled = yamlScalar(rawValue) !== false
  } else if (key === 'quota') {
    record.quota = yamlScalar(rawValue) ?? -1
  }
}

/** Split a virtual id `<source>::<model>` back into its hop. */
function parseRoute(id) {
  if (typeof id !== 'string') return undefined
  const at = id.indexOf(SEP)
  if (at <= 0 || at + SEP.length >= id.length) return undefined
  const source = id.slice(0, at)
  const model = id.slice(at + SEP.length)
  if (source === '' || model === '') return undefined
  return { source, model }
}

/**
 * Throw a failure carrying machine-readable facts the harness normalizes.
 */
function routedFailure(message, code) {
  const error = new Error(message)
  error.code = code
  error.failure = { message, code }
  return error
}

/**
 * Fold an auxiliary stream's chunks into verdict text plus usage.
 *
 * Only visible text is collected: reasoning deltas are dropped, tool-call
 * deltas are skipped, and a terminal error/aborted finish becomes the failure
 * payload instead of throwing. Adapters guarantee usage before finish and
 * nothing after, so this loop ends exactly once.
 */
async function collectText(stream, signal) {
  let text = ''
  let failed = null
  let sawFinish = false
  let usage = null
  const open = new Map()
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        open.set(chunk.index, (open.get(chunk.index) ?? '') + chunk.text)
        break
      case 'block-end':
        if (chunk.block?.type === 'text') {
          open.delete(chunk.index)
          text += chunk.block.text
        } else {
          open.delete(chunk.index)
        }
        break
      case 'usage':
        usage = chunk.usage ?? usage
        break
      case 'finish': {
        sawFinish = true
        const reason = chunk.reason
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
          failed = reason.failure ?? { message: 'adapter finish failure', code: 'LLM_FAILURE' }
        }
        break
      }
      default:
        break
    }
    signal?.throwIfAborted?.()
  }
  if (!failed && !sawFinish) {
    for (const index of [...open.keys()].sort((a, b) => a - b)) text += open.get(index) ?? ''
  }
  const tokens = usage === null ? 0
    : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  return { text, failed, tokens }
}

/** Instruction the called models receive as their system prompt. */
const JUDGE_SYSTEM = [
  'You are an independent verifier answering on your own.',
  'You will receive a task and, when provided, material to verify against.',
  'Judge the task strictly from the given task and material alone; do not rely',
  'on outside assumptions, and do not echo either input verbatim.',
  'Reply with your direct conclusion first, then the reasoning behind it.',
  'Answer in the language of the task.',
].join('\n')

/**
 * Runtime consumption ledger, keyed by virtual id.
 *
 * Quotas are manually maintained in config; consumption is process-local.
 * Each slot remembers the quota baseline it was loaded from so a panel
 * reset (baseline change) restarts the balance instead of carrying stale
 * spend across it.
 */
const ledgers = new Map()

/** Exact-entry lookup for one virtual id (wildcard does not pin a model). */
function exactEntry(routes, source, model) {
  return routes.find(route => route.source === source && route.model === model && route.model !== WILDCARD)
}

/** Read the remaining budget for one target; null means unlimited. */
function remainingOf(entry) {
  const quota = entry === undefined ? -1 : entry.quota
  return quota < 0 ? null : quota
}

/** Take or renew a ledger slot against the current config baseline. */
function ledgerSlot(virtualId, entry) {
  const quota = remainingOf(entry)
  if (quota === null) return { unlimited: true, left: null }
  let slot = ledgers.get(virtualId)
  if (slot === undefined || slot.base !== quota) slot = { base: quota, left: quota }
  if (slot.left <= 0) slot.left = 0
  return { unlimited: false, left: slot.left }
}

/** Charge one completed call; unlimited slots ignore the cost. */
function charge(virtualId, tokens) {
  const slot = ledgers.get(virtualId)
  if (slot === undefined || slot.unlimited || slot.left === null) return
  ledgers.set(virtualId, { ...slot, left: Math.max(0, slot.left - tokens) })
}

/**
 * Normalize tool arguments defensively.
 *
 * A transport may hand over stringified JSON rather than an object; a string
 * task is kept, arrays are coerced to strings, and anything else becomes ''
 * / []. Task text and materials always reach the called models.
 */
function normalizeArgs(input) {
  let args = input
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = {}
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {}
  // Some dispatchers wrap the parameter object as { args: <params> }; unwrap
  // that envelope before reading fields, keeping flat objects untouched.
  if (!Array.isArray(args) && Object.keys(args).length === 1 && Object.hasOwn(args, 'args')
    && args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args)) {
    args = args.args
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {}
  const strList = value => Array.isArray(value)
    ? value.map(item => String(item))
    : typeof value === 'string' ? [value] : []
  return {
    task: typeof args.task === 'string' ? args.task : valueToString(args.task),
    materials: strList(args.materials),
    targets: strList(args.targets),
  }
}

/** Render any scalar/JSONish value to text for the task field. */
function valueToString(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function apply(ctx, config) {
  const llm = ctx.llm

  /** Missing sources warned once each, never spamming per request. */
  const warnedMissing = new Set()

  /** Resolve the target provider's adapter; absence degrades instead of crashing. */
  const adapterFor = (source) => {
    try {
      return llm.registration(source)?.adapter
    } catch {
      return undefined
    }
  }

  const warnMissing = (source) => {
    if (warnedMissing.has(source)) return
    warnedMissing.add(source)
    ctx.logger.warn(
      `dsh-provider-router: no adapter registered for source provider "${source}"; `
      + 'its routing entries fail at request time until the provider mounts again',
    )
  }

  /**
   * Effective callable set: exact entry decides one model; a "*" entry marks
   * the whole source. The model the conversation itself runs on is always
   * removed — never calling itself, whether native or delegated.
   */
  const eligibleTargets = async ({ ownPair }) => {
    // Primary source: the live volatile config. If it presents an empty table
    // (observed after row toggles), fall back to the durable patch document —
    // the same file the Settings panel writes, so both views agree again.
    let routes = liveRoutes(config)
    if (routes.length === 0) routes = routesFromProfile()
    const out = []
    const seen = new Set()
    const wildcardBySource = new Map()
    for (const route of routes) {
      if (route.model === WILDCARD) wildcardBySource.set(route.source, route.enabled)
    }
    for (const route of routes) {
      if (route.model === WILDCARD) continue
      const checked = route.enabled
      const id = `${route.source}${SEP}${route.model}`
      if (!checked || seen.has(id)) continue
      if (ownPair && ((ownPair.provider === route.source && ownPair.model === route.model))) continue
      seen.add(id)
      out.push(id)
    }
    // Sources without any explicit entry but with an active wildcard.
    //
    // Enumeration MUST go through the service method `ctx.llm.listModels`,
    // NOT the raw adapter: other plugins' visibility policies (dsh-model-tidy
    // hiding rows from the selector) wrap exactly this method. Reading the raw
    // adapter catalog silently included every model the adapter knows — hidden
    // ones included — so a "*" entry expanded beyond anything the user could
    // see or veto, leaking calls to models never placed on any list.
    for (const [source, enabled] of wildcardBySource) {
      if (!enabled) continue
      let catalogue = []
      try {
        catalogue = await llm.listModels(source)
      } catch {
        catalogue = []
      }
      for (const model of catalogue ?? []) {
        const id = `${source}${SEP}${model.id}`
        if (seen.has(id)) continue
        // Same self-call guard as exact entries: a wildcard must never offer
        // the model this conversation itself runs on.
        if (ownPair && ownPair.provider === source && ownPair.model === model.id) continue
        seen.add(id)
        out.push(id)
      }
    }
    return out
  }

  /**
   * One target: budget check, build the prompt, delegate, fold chunks to text.
   *
   * Each target carries its OWN deadline (TARGET_TIMEOUT_MS): a hanging free
   * endpoint fails only itself with a TARGET_TIMEOUT verdict while its
   * siblings keep streaming — one slow judge used to stall the entire batch
   * until the outer policy killed everything, discarding good verdicts.
   */
  const runOne = async (virtualId, args, signal) => {
    const route = parseRoute(virtualId)
    if (route === undefined) throw routedFailure(`not a callable model: ${virtualId}`, 'ROUTE_NOT_FOUND')
    const inner = adapterFor(route.source)
    if (!inner) {
      warnMissing(route.source)
      throw routedFailure(`no adapter registered for source provider "${route.source}"`, 'NO_ADAPTER')
    }
    const routes = liveRoutes(config)
    const entry = exactEntry(routes, route.source, route.model)
    const budget = ledgerSlot(virtualId, entry)
    if (!budget.unlimited && budget.left !== null && budget.left <= 0) {
      throw Object.assign(new Error('quota exhausted'), { code: 'QUOTA_EXHAUSTED' })
    }
    const parts = [String(args?.task ?? '')]
    for (const [index, material] of (Array.isArray(args?.materials) ? args.materials : []).entries()) {
      if (typeof material === 'string' && material !== '') parts.push(`【Material ${index + 1}】\n${material}`)
    }
    const messages = [
      { role: 'system', content: [{ type: 'text', text: JUDGE_SYSTEM }] },
      { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] },
    ]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TARGET_TIMEOUT_MS)
    const onCallerAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onCallerAbort, { once: true })
    let result
    try {
      result = await collectText(
        llm.stream({ provider: route.source, model: route.model, messages, signal: controller.signal }),
        controller.signal,
      )
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw error
        throw Object.assign(
          new Error(`target timed out after ${Math.round(TARGET_TIMEOUT_MS / 1000)}s`),
          { code: 'TARGET_TIMEOUT' },
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onCallerAbort)
    }
    const { text, failed, tokens } = result
    if (failed) throw Object.assign(new Error(failed.message ?? 'verification failed'), { code: failed.code })
    charge(virtualId, tokens)
    return {
      text,
      tokens,
      left: budget.unlimited ? null : budget.left === null ? null : Math.max(0, budget.left - tokens),
    }
  }

  ctx.tools.register(
    {
      name: 'router_call',
      description: [
        'Borrow other attached providers’ third-party models IN PARALLEL for independent judgment — verifying a conclusion, cross-checking a plan, collecting several independent verdicts. Repeat freely and in any combination: P→C1, then P→C2, then P→C1+C3; each call’s scope is yours to choose.',
        'No user confirmation needed: targets are the models checked in Settings → Provider Router, excluding the model this conversation itself runs on (removed automatically).',
        'Omit "targets" to use every currently checked model; give explicit virtual ids ("qiniuyun::moonshotai/kimi-k3") to narrow it to specific ones, same or different each time.',
        'Each called model sees only "task" plus optional "materials" — no other conversation history — so verdicts are genuinely independent. Think of it as a scripted model call: input information → the model → returned packages.',
        'Every verdict reports this call’s token cost and the target’s remaining quota (negative budget = unlimited; see Settings). Use those balances to decide how large each subtask may be, and pick different targets as budgets shift.',
        'Returns one verdict per target (status + verbatim conclusion); summarize them yourself in your reply.',
      ].join(' '),
      parameters: {
        task: {
          type: 'string',
          required: true,
          description: 'What the called models should do or answer — self-contained, understandable without the rest of the conversation',
        },
        materials: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional evidence / documents / conclusions to verify against; each entry becomes one labeled section for every caller',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: `Optional explicit virtual model ids like "qiniuyun::moonshotai/kimi-k3". Omit to fan out to ALL currently checked models (current model excluded)`,
        },
      },
      // Flat string-array contract: the enforced JSON subset accepts it
      // without nested-object declarations, so a verdict payload can never be
      // rejected by schema convergence (a rejected value is reported to the
      // model as an empty error result).
      output: {
        schema: { type: 'array', items: { type: 'string' } },
        render: (_args, value) => [{ type: 'text', text: Array.isArray(value) ? value.join('\n\n') : '' }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Router Call',
        kind: 'other',
        rawInput: {
          task: String(args?.task ?? ''),
          materials: Array.isArray(args?.materials) ? args.materials : [],
          targets: Array.isArray(args?.targets) ? args.targets : [],
        },
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: `Router Call · ${(result?.content ?? []).length} block(s)`,
        content: result?.content,
      }),
      // Outer policy budget: per-target deadlines do the real bounding; this
      // only guards pathological batches so the tool settles inside policy.
      timeoutMs: Math.max(TARGET_TIMEOUT_MS * 2, 180_000),
      execute: async (args, exec) => {
        const ownPair = exec.agent?.model?.current?.()
        const input = normalizeArgs(args)
        let targets = await eligibleTargets({ ownPair })
        const wanted = input.targets
        if (wanted.length > 0) {
          targets = targets.filter(id => wanted.includes(id))
          if (targets.length === 0) {
            throw Object.assign(new Error('none of the requested targets are currently checked — select them in Settings → Provider Router'), { code: 'ROUTE_NOT_CHECKED' })
          }
        }
        if (exec.signal?.aborted) {
          throw Object.assign(new Error('router_call cancelled'), { name: 'AbortError', code: 'ABORTED' })
        }
        const lines = await Promise.all(targets.map(async (target) => {
          try {
            const outcome = await runOne(target, input, exec.signal)
            const budget = ` · ${outcome.tokens} tok used · left ${outcome.left === null ? '∞' : outcome.left}`
            return `✓ ${target}\n${outcome.text || '(empty)'}${budget}`
          } catch (error) {
            const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'ROUTE_FAILED'
            return `✗ ${target} (${code})\n${String(error?.message ?? error)}`
          }
        }))
        const okCount = lines.filter(line => line.startsWith('✓')).length
        return [`Router call: ${okCount}/${targets.length} verdicts returned`, ...lines]
      },
    },
    {},
  )

  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dsh-provider-router: settings wiring')
  })

  const mountedRoutes = liveRoutes(config)
  const sources = [...new Set(mountedRoutes.map(route => route.source))]
  ctx.logger.info(
    `dsh-provider-router: mounted · router_call tool · ${mountedRoutes.length} entries from [${sources.join(', ') || '-'}] · no virtual route`,
  )
}