/**
 * dsh-provider-router — browser half.
 *
 * Served by the harness's client module system, which is why this file is a
 * `window.__ModuleLoader__.load` factory rather than an ES module: the loader
 * hands the factory a synchronous CommonJS `require`, and that is how the
 * shared `react` runtime is reached.
 *
 * One settings page — "Provider Router": every third-party model the attached
 * providers advertise, one toggle switch per model (never a native checkbox:
 * the pane re-renders plain attribute-driven DOM reliably), plus one
 * remaining-token NUMBER INPUT per model showing the raw value (-1 default;
 * negative means unlimited — that mapping stays backend-only). Toggles decide
 * which models the running conversation's `router_call` tool may fan out to;
 * quotas gate each call so the parent model can size subtasks against real
 * budgets. Everything writes straight into the plugin's volatile config —
 * hot-edited, restart-persisted.
 */
window.__ModuleLoader__.load({
  id: 'dsh-provider-router',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const { useState, useEffect, useRef } = react
    const h = react.createElement

    /** Namespace shared with the host half; the settings section id. */
    const NS = 'provider-router'
    const STYLE_ID = 'dsh-provider-router-styles'
    /** Separator between source provider and model inside a virtual id. */
    const SEP = '::'

    //#region locales
    const zh = {
      nav: 'Provider Router',
      title: '第三方模型调用',
      subtitle: '勾选你其他已挂载 provider 名下的模型。本对话的主模型在需要时会多次、并行调用这些已勾选的模型做独立核验（P→C1、P→C2、P→C1+C3…），每次传入哪些信息由主模型决定——无需逐轮确认，也绝不调用本对话正在使用的模型本身。',
      search: '搜索模型名或渠道',
      checkedOf: '已勾选 {n}/{total} 个模型',
      empty: '没有匹配的模型。',
      loading: '正在读取模型目录…',
      loadError: '目录加载失败：{message}',
      retry: '重试',
      saving: '保存中…',
      saveError: '保存失败：{message}',
      clearAll: '清空全部勾选',
      clearAllConfirm: '确定要取消所有 provider 的全部勾选吗？',
      resetQuota: '全部配额重置为无限（-1）',
      resetQuotaConfirm: '把所有已填配额的模型重置为负数（无限）？',
      confirmReset: '再点一次确认重置',
      confirmClear: '再点一次确认清空',
      refresh: '刷新清单',
      groupAll: '整组（该 provider 的全部模型）',
      groupPartial: '{n}/{total}',
      quotaLabel: '剩余 token',
      unlimitedHint: '负数＝无限',
      quotaTitle: '手动维护的剩余可用 token（负数＝无限，默认 -1）。主模型会按它决定拆分子任务的大小。',
      tipTitle: '说明',
      tipBody: [
        '· 主通道＝本对话当前生效的模型，永远不会被调用自己（自动排除）。',
        '· 组开关按“或”判定：任一名下模型被勾选，该 provider 即为开；全部取消才为关。',
        '· 点组开关＝整组动作：开则全部模型一次全开；关则清空该 provider 的全部条目（含单独勾选的）。',
        '· 单独开关某个模型不影响其他模型的状态（同理，任一为真，该 provider 即为真）。',
        '· 配额是手动账本：负数（默认）＝无限；扣减发生在调用时并在返回里报告，主模型据此决定下一个子任务大小。',
        '· 若要接入新上游 API，请先在「设置 → 模型」里添加该 provider，随后即可在此勾选。',
      ].join('\n'),
      toolHint: '主模型在需要时会自行调用工具 router_call（无需你介入）；范围是「已勾选且非自身」的模型，可用 targets 参数精确指定。',
    }

    const en = {
      nav: 'Provider Router',
      title: 'Third-party model calls',
      subtitle: 'Tick the third-party models under your other attached providers. The main model running this conversation calls those checked models in parallel, again and again (P→C1, P→C2, P→C1+C3…), deciding itself which information enters each call — no per-turn confirmation, never the model the conversation itself runs on.',
      search: 'Search models or providers',
      checkedOf: '{n}/{total} models checked',
      empty: 'No matching models.',
      loading: 'Reading model catalogue…',
      loadError: 'Catalog failed: {message}',
      retry: 'Retry',
      saving: 'Saving…',
      saveError: 'Save failed: {message}',
      clearAll: 'Clear all checks',
      clearAllConfirm: 'Remove every check across all providers?',
      resetQuota: 'Reset all quotas to unlimited (-1)',
      resetQuotaConfirm: 'Reset every filled quota to negative (unlimited)?',
      confirmReset: 'Click again to confirm reset',
      confirmClear: 'Click again to confirm clear',
      groupAll: 'whole provider ("*" entry)',
      groupPartial: '{n}/{total}',
      quotaLabel: 'remaining tokens',
      unlimitedHint: 'negative = unlimited',
      quotaTitle: 'Manually maintained remaining tokens; negative means unlimited, default -1. The parent model sizes subtasks against these.',
      tipTitle: 'Notes',
      tipBody: [
        '· Main channel = the model currently serving this conversation; it is never called itself (excluded automatically).',
        '· The provider switch follows OR: it is ON whenever ANY model under it is checked, and OFF only when every one is unchecked.',
        '· Clicking the group switch acts on the whole provider: ON checks every model at once; OFF clears all of that provider\'s entries (pins included).',
        '· Toggling one model leaves its siblings untouched — same rule: any model on keeps the provider on.',
        '· Quotas are a manual ledger: negative (default) = unlimited; consumption happens at call time and is reported back, and the parent model sizes its next subtask accordingly.',
        '· For new upstream APIs, add the provider under Settings → Models first; it becomes checkable here afterwards.',
      ].join('\n'),
      toolHint: 'The main model invokes router_call itself when needed — no action from you; scope = checked non-self models, narrowable via targets.',
    }
    //#endregion

    //#region styles
    const STYLES = `
.dsh-pr-root { padding: 2px 0 16px; font-size: 13px; }
.dsh-pr-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2328); }
.dsh-pr-subtitle { margin-top: 4px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #57606a); }
.dsh-pr-toolbar { display: flex; gap: 10px; align-items: center; margin: 14px 0 8px; flex-wrap: wrap; }
.dsh-pr-search {
  flex: 1 1 220px; height: 32px; padding: 0 11px; font-size: 13px;
  border-radius: var(--dsw-radius-lg, 10px);
  border: 1px solid var(--dsw-alias-border-l3, #d0d7de);
  background: transparent; color: var(--dsw-alias-label-primary, #1f2328); outline: none;
}
.dsh-pr-search:focus { border-color: var(--dsw-focus-ring-color, #2681ff); }
.dsh-pr-status { color: var(--dsw-alias-label-secondary, #57606a); white-space: nowrap; }
.dsh-pr-btn {
  height: 28px; padding: 0 12px; font-size: 12px; cursor: pointer;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l3, #d0d7de);
  background: transparent; color: var(--dsw-alias-label-primary, #1f2328);
}
.dsh-pr-btn:hover { background: var(--dsw-alias-fill-secondary, rgba(175,184,193,.12)); }
.dsh-pr-btn-danger { color: var(--dsw-alias-state-error, #cf222e); }
/* Armed two-step confirmation state: the button itself signals "click again". */
.dsh-pr-btn-armed { background: var(--dsw-alias-state-error-fill, #cf222e); border-color: transparent; color: #fff; }
.dsh-pr-btn-armed:hover { background: var(--dsw-alias-state-error-hover, #a40e26); }
.dsh-pr-tip { margin-top: 10px; }
.dsh-pr-tip summary { cursor: pointer; color: var(--dsw-alias-label-secondary, #57606a); font-size: 12px; }
.dsh-pr-tip-body { margin-top: 6px; padding-left: 14px; line-height: 1.75; color: var(--dsw-alias-label-secondary, #57606a); white-space: pre-line; }
.dsh-pr-group { border-top: 1px solid var(--dsw-alias-border-l2, #eaeef2); margin-top: 8px; }
.dsh-pr-group-head { display: flex; align-items: center; gap: 8px; padding: 7px 4px; flex-wrap: wrap; }
.dsh-pr-group-name { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2328); }
.dsh-pr-group-count { color: var(--dsw-alias-label-tertiary, #848d97); font-size: 12px; }
.dsh-pr-group-id { color: var(--dsw-alias-label-quaternary, #a4abb3); font-size: 11px; }
.dsh-pr-row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 4px 4px 26px; border-radius: var(--dsw-radius-sm, 6px);
}
.dsh-pr-row:hover { background: var(--dsw-alias-fill-secondary, rgba(175,184,193,.08)); }
.dsh-pr-row-name { color: var(--dsw-alias-label-primary, #1f2328); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-pr-row-meta { color: var(--dsw-alias-label-tertiary, #848d97); font-size: 12px; }
/* Toggle switch, not a native checkbox: the settings pane renders plain
 * attribute-driven DOM reliably, and a switch cannot hold a stale visual
 * after its props change (the native checked property did exactly that here). */
.dsh-pr-switch {
  flex: 0 0 auto; width: 32px; height: 18px; padding: 0; cursor: pointer;
  border-radius: 999px; border: none; position: relative;
  background: var(--dsw-alias-state-border-secondary, #cfd4da);
  transition: background .12s ease;
}
.dsh-pr-switch[aria-checked="true"] { background: var(--dsw-alias-state-success-fill, #2da44e); }
.dsh-pr-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--dsw-alias-label-primary-inverted, #fff);
  transition: transform .12s ease;
}
.dsh-pr-switch[aria-checked="true"]::after { transform: translateX(14px); }
/* Real number input showing the RAW stored value (-1 = unlimited). This is
 * an INPUT, not a display cell: the pane may swallow window.prompt and other
 * indirect editors, but an uncontrolled <input> always accepts typing. */
.dsh-pr-quota {
  width: 96px; height: 26px; padding: 0 8px; font-size: 12px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px dashed var(--dsw-alias-border-l3, #d0d7de);
  background: transparent; color: var(--dsw-alias-label-primary, #1f2328);
  text-align: right;
}
.dsh-pr-quota:focus { outline: none; border-color: var(--dsw-focus-ring-color, #2681ff); }
.dsh-pr-quota:hover { border-color: var(--dsw-focus-ring-color, #2681ff); }
.dsh-pr-error { color: var(--dsw-alias-state-error, #cf222e); margin-top: 8px; }
.dsh-pr-toolhint { margin-top: 12px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2, rgba(175,184,193,.10)); color: var(--dsw-alias-label-secondary, #57606a); line-height: 1.6; }
`
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }
    //#endregion

    //#region controller
    const keyOf = (provider, model) => provider + '\u0000' + model

    class RouterController {
      constructor(form, readCatalog) {
        this.form = form
        this.readCatalog = readCatalog
        this.listeners = new Set()
        this.groups = null
        this.loadError = ''
        this.writeError = ''
        this.saving = false
        this.disposed = false
        this.generation = 0
        if (typeof form?.subscribe === 'function') {
          this.unsubscribeForm = form.subscribe(() => {
            if (!this.disposed) this.emit()
          })
        }
      }

      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      emit() {
        for (const listener of this.listeners) listener()
      }

      section() {
        const snapshot = this.form?.getSnapshot?.()
        const value = snapshot?.value
        return value !== null && typeof value === 'object' ? value : {}
      }

      async save(next) {
        this.saving = true
        this.writeError = ''
        this.emit()
        try {
          await this.form.set('routes', next)
        } catch (error) {
          this.writeError = String(error?.message ?? error)
        } finally {
          this.saving = false
          this.emit()
        }
        this.emit()
        return this.writeError === ''
      }

      // --- view ---------------------------------------------------------

      /**
       * Effective state per model: an exact entry wins; otherwise the
       * source's "*" entry decides the whole group. Quota likewise comes
       * from the exact entry (absent = unlimited default).
       *
       * The GROUP switch follows pure OR semantics: it is on iff ANY model
       * under that provider is effectively checked. A tri-state "some but
       * not all" reading made the group appear off when every model was on
       * (all individually pinned, no "*" entry) — the opposite of intent.
       */
      view(groups) {
        const routes = Array.isArray(this.section().routes) ? this.section().routes : []
        const byKey = new Map()
        const wildcardBySource = new Map()
        for (const entry of routes) {
          if (entry === null || typeof entry !== 'object') continue
          const source = typeof entry.source === 'string' ? entry.source : ''
          const model = typeof entry.model === 'string' ? entry.model : ''
          if (source === '' || model === '') continue
          if (model === '*') {
            if (!wildcardBySource.has(source)) wildcardBySource.set(source, entry.enabled !== false)
            continue
          }
          byKey.set(keyOf(source, model), entry)
        }
        return (groups ?? []).map(group => {
          const wildcardOn = wildcardBySource.get(group.id) === true
          const rows = group.models.map(model => {
            const entry = byKey.get(keyOf(group.id, model.id))
            const checked = entry ? entry.enabled !== false : wildcardOn
            return {
              providerId: group.id,
              providerName: group.name,
              modelId: model.id,
              modelName: model.name,
              entry,
              checked,
              quota: typeof entry?.quota === 'number' ? entry.quota : -1,
              wildcardOnly: !entry && wildcardOn,
            }
          })
          return { ...group, wildcardOn, rows }
        })
      }

      // --- mutations ------------------------------------------------------

      /**
       * Write one model's checkbox WITHOUT touching its group's "*" entry:
       * the individual pin stands next to the bulk switch, and removing the
       * bulk switch would silently uncheck siblings that were never touched.
       * (The group switch itself follows OR logic: any pin keeps it on.)
       */
      async toggleModel(providerId, modelId, wanted) {
        const routes = Array.isArray(this.section().routes) ? [...this.section().routes] : []
        const at = routes.findIndex(r => r?.source === providerId && r?.model === modelId && r?.model !== '*')
        const entry = { source: providerId, model: modelId, enabled: !!wanted }
        if (at >= 0) routes[at] = entry
        else routes.push(entry)
        return this.save(routes)
      }

      /**
       * Bulk switch — full control of the whole provider, consistent with
       * the OR display: turning ON clears that source's individual pins and
       * enables the "*" entry (every model callable at once); turning OFF
       * removes every entry of the source (wildcard and pins alike), so the
       * group cannot stay logically on after the user switched it off.
       */
      async toggleWildcard(providerId, wanted) {
        const routes = Array.isArray(this.section().routes) ? [...this.section().routes] : []
        const belongs = r => r?.source === providerId
        const rest = routes.filter(r => !belongs(r))
        if (!wanted) return this.save(rest)
        const next = [...rest, { source: providerId, model: '*', enabled: true }]
        return this.save(next)
      }

      /** Write one model's remaining-token budget, inheriting its check state. */
      async setQuota(providerId, modelId, rawValue) {
        const routes = Array.isArray(this.section().routes) ? [...this.section().routes] : []
        const at = routes.findIndex(r => r?.source === providerId && r?.model === modelId && r?.model !== '*')
        const trimmed = String(rawValue ?? '').trim()
        const quota = trimmed === '' || trimmed === '-' ? -1 : Number(trimmed)
        if (!Number.isFinite(quota)) return false
        const existing = at >= 0 ? routes[at] : undefined
        const enabled = existing ? existing.enabled !== false : this.effectiveChecked(providerId, modelId)
        const entry = { source: providerId, model: modelId, enabled, quota }
        if (at >= 0) routes[at] = entry
        else routes.push(entry)
        return this.save(routes)
      }

      /** Read whether one model is effectively checked before quota edits. */
      effectiveChecked(providerId, modelId) {
        const routes = Array.isArray(this.section().routes) ? this.section().routes : []
        for (const entry of routes) {
          if (entry?.source === providerId && entry?.model === modelId && entry?.model !== '*') {
            return entry.enabled !== false
          }
        }
        for (const entry of routes) {
          if (entry?.source === providerId && entry?.model === '*') return entry.enabled !== false
        }
        return false
      }

      /** Reset every explicitly-set quota to -1 (unlimited). */
      async resetQuota() {
        const routes = Array.isArray(this.section().routes) ? [...this.section().routes] : []
        const next = routes.map(entry => (
          entry && entry.model !== '*' && typeof entry.quota === 'number'
            ? { ...entry, quota: -1 }
            : entry
        ))
        return this.save(next)
      }

      /** Drop every entry belonging to one source. */
      async clearProvider(providerId) {
        const routes = Array.isArray(this.section().routes) ? [...this.section().routes] : []
        return this.save(routes.filter(r => r?.source !== providerId))
      }

      /** Drop everything. */
      async clearAll() {
        return this.save([])
      }

      /** Reload the catalogue from the registry. */
      async load() {
        const generation = ++this.generation
        this.emit()
        try {
          const groups = await this.readCatalog()
          if (generation !== this.generation || this.disposed) return
          this.groups = (groups ?? []).map(group => ({
            id: String(group?.id ?? ''),
            name: String(group?.name ?? group?.id ?? ''),
            models: (group?.models ?? []).map(model => ({
              id: String(model?.id ?? ''),
              name: String(model?.name ?? model?.id ?? ''),
            })).filter(model => model.id !== ''),
          })).filter(group => group.id !== '')
          this.loadError = ''
        } catch (error) {
          if (generation !== this.generation || this.disposed) return
          this.loadError = String(error?.message ?? error)
        }
        this.emit()
      }
    }
    //#endregion

    //#region panel
    /**
     * Toggle switch (role="switch"), deliberately not a native checkbox —
     * dsh-model-tidy makes the same call for this same pane: plain
     * attribute-driven DOM always matches the current props, so a toggle can
     * never be caught in its old visual state after an edit.
     */
    function SwitchToggle({ checked, onChange, title }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-pr-switch',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          onClick: () => onChange(!checked),
          title: title ?? '',
        },
      )
    }

    /**
     * Quota as a REAL number input, not a display cell.
     *
     * Shows the raw stored value: -1 (or any negative) means unlimited — that
     * mapping lives in the backend only. Uncontrolled on purpose: this pane's
     * DOM serialization does not reconcile attribute diffs reliably, so the
     * input renders its initial value once and then trusts the browser for
     * every keystroke. Writes land on blur / Enter.
     */
    function QuotaInput({ group, modelId, initial, t, controller }) {
      return h('input', {
        className: 'dsh-pr-quota',
        type: 'number',
        step: 'any',
        defaultValue: String(initial ?? -1),
        title: `${t('quotaTitle')}（${t('quotaLabel')}：${t('unlimitedHint')}）`,
        onBlur: e => commitQuota(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter') e.currentTarget.blur()
        },
      })
      function commitQuota(raw) {
        const trimmed = String(raw ?? '').trim()
        const num = Number(trimmed)
        // Keep what the user typed if it parses; a blank box normalizes to -1,
        // exactly like the host treats a missing quota field.
        controller.setQuota(group.id, modelId, trimmed === '' || !Number.isFinite(num) ? -1 : num)
      }
    }

    function RouterPanel({ controller, t }) {
      const [query, setQuery] = useState('')
      const [, forceRender] = useState(0)
      const [withError, setWithError] = useState(null)
      // Destructive actions (reset all quotas, clear all checks) cannot delegate
      // to window.confirm — this webview blocks native dialogs (window.prompt
      // demonstrably fails the same way here). The button arms on the first
      // click and executes on the second; anything else re-arms after 4 s.
      const [armedAction, setArmedAction] = useState(null)
      const disarmTimer = useRef(null)

      useEffect(() => {
        return controller.subscribe(() => forceRender(n => n + 1))
      }, [controller])
      useEffect(() => {
        ensureStyles()
      }, [])
      useEffect(() => {
        void controller.load()
      }, [controller])
      useEffect(() => () => { if (disarmTimer.current) clearTimeout(disarmTimer.current) }, [])

      function armOrRun(actionName, run) {
        if (armedAction === actionName) {
          if (disarmTimer.current) clearTimeout(disarmTimer.current)
          disarmTimer.current = null
          setArmedAction(null)
          void run()
          return
        }
        if (armedAction !== null) return
        setArmedAction(actionName)
        disarmTimer.current = setTimeout(
          () => setArmedAction(current => (current === actionName ? null : current)),
          4000,
        )
      }

      const allView = controller.view(controller.groups ?? [])
      const needle = query.trim().toLowerCase()
      const filtered = needle === ''
        ? allView
        : allView.filter(group =>
          `${group.name} ${group.id}`.toLowerCase().includes(needle)
          || group.rows.some(row => `${row.modelName} ${row.modelId}`.toLowerCase().includes(needle)))
      const visibleRows = filtered.reduce((sum, group) => sum + group.rows.length, 0)
      const checkedTotal = filtered.reduce(
          (sum, group) => sum + group.rows.filter(row => row.checked).length,
          0,
        )

      const wrap = (fn) => async (...args) => {
        setWithError(null)
        try {
          await fn(...args)
        } catch (error) {
          setWithError(String(error?.message ?? error))
        }
      }

      return h(
        'div',
        { className: 'dsh-pr-root' },
        h('div', { className: 'dsh-pr-title' }, t('title')),
        h('div', { className: 'dsh-pr-subtitle' }, t('subtitle')),
        h(
          'div',
          { className: 'dsh-pr-toolbar' },
          h('input', {
            className: 'dsh-pr-search',
            placeholder: t('search'),
            value: query,
            onChange: e => setQuery(e.target.value),
          }),
          h('span', { className: 'dsh-pr-status' },
            controller.loadError
              ? t('loadError', { message: controller.loadError })
              : t('checkedOf', { n: checkedTotal, total: visibleRows }),
          ),
          h('button', {
            className: 'dsh-pr-btn dsh-pr-btn-danger' + (armedAction === 'clearAll' ? ' dsh-pr-btn-armed' : ''),
            // Inline style as the second channel: pure className changes are not
            // reliably reconciled by this pane's DOM serialization (the earlier
            // native-checkbox staleness had the same root), but an inline style
            // always lands on the element.
            style: armedAction === 'clearAll'
              ? { backgroundColor: '#cf222e', color: '#fff', borderColor: 'transparent' }
              : undefined,
            disabled: controller.saving || (armedAction !== null && armedAction !== 'clearAll'),
            onClick: () => armOrRun('clearAll', () => controller.clearAll()),
            title: t('clearAll'),
          }, armedAction === 'clearAll' ? t('confirmClear') : t('clearAll')),
          h('button', {
            className: 'dsh-pr-btn' + (armedAction === 'resetQuota' ? ' dsh-pr-btn-armed' : ''),
            style: armedAction === 'resetQuota'
              ? { backgroundColor: '#cf222e', color: '#fff', borderColor: 'transparent' }
              : undefined,
            disabled: controller.saving || (armedAction !== null && armedAction !== 'resetQuota'),
            onClick: () => armOrRun('resetQuota', () => controller.resetQuota()),
            title: t('quotaTitle'),
          }, armedAction === 'resetQuota' ? t('confirmReset') : t('resetQuota')),
          h('button', {
            className: 'dsh-pr-btn',
            onClick: wrap(() => controller.load()),
            title: t('refresh'),
          }, t('refresh')),
        ),
        controller.loadError && controller.groups === null
          ? h('div', { className: 'dsh-pr-error' },
              t('loadError', { message: controller.loadError }),
              ' ', h('button', { className: 'dsh-pr-btn', onClick: wrap(() => controller.load()) }, t('retry')),
            )
          : null,
        filtered.length === 0
          ? h('div', { className: 'dsh-pr-status' },
              controller.groups === null ? t('loading') : t('empty'))
          : filtered.map(group => h(
            'div',
            { className: 'dsh-pr-group', key: group.id },
            h(
              'div',
              { className: 'dsh-pr-group-head' },
              h(SwitchToggle, {
                // OR semantics: the provider switch is on iff ANY of its
                // models is checked. Full on/off is decided by the bulk click.
                checked: group.rows.some(row => row.checked),
                title: t('groupAll'),
                onChange: wrap(value => controller.toggleWildcard(group.id, value)),
              }),
              h('span', { className: 'dsh-pr-group-name' }, group.name),
              h('span', { className: 'dsh-pr-group-count' },
                t('groupPartial', { n: group.rows.filter(row => row.checked).length, total: group.rows.length })),
              h('span', { className: 'dsh-pr-group-id' }, group.id),
              h('button', {
                className: 'dsh-pr-btn dsh-pr-btn-danger',
                onClick: wrap(() => controller.clearProvider(group.id)),
                title: t('clearAll'),
              }, '×'),
            ),
            group.rows.map(row => h(
              'div',
              { className: 'dsh-pr-row', key: keyOf(group.id, row.modelId) },
              h(SwitchToggle, {
                checked: row.checked,
                title: row.wildcardOnly ? `${row.modelId} · ${t('groupAll')}` : row.modelId,
                onChange: wrap(value => controller.toggleModel(group.id, row.modelId, value)),
              }),
              h('span', { className: 'dsh-pr-row-name' }, row.modelName || row.modelId),
              h('span', { className: 'dsh-pr-row-meta' }, row.modelId === row.modelName ? '' : row.modelId),
              h(QuotaInput, {
                // Key includes the CURRENT value: a changed quota forces a full
                // remount, so the input's defaultValue re-applies. An uncontrolled
                // input would otherwise freeze on its first rendered value even
                // while the parent already holds the newer one (this pane does not
                // reconcile attribute diffs for such elements).
                key: `q-${keyOf(group.id, row.modelId)}-${row.quota}`,
                controller,
                t,
                group,
                modelId: row.modelId,
                initial: row.quota,
              }),
            )),
          )),
        controller.writeError
          ? h('div', { className: 'dsh-pr-error' }, t('saveError', { message: controller.writeError }))
          : null,
        h('details', { className: 'dsh-pr-tip' },
          h('summary', null, `${t('tipTitle')}（${checkedTotal}/${visibleRows}）`),
          h('div', { className: 'dsh-pr-tip-body' }, t('tipBody')),
        ),
        h('div', { className: 'dsh-pr-toolhint' }, t('toolHint')),
        withError ? h('div', { className: 'dsh-pr-error' }, withError) : null,
      )
    }
    //#endregion

    //#region apply
    const name = 'dsh-provider-router'
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'provider-router: copy dictionaries')

      const form = ctx.configForms.get(NS)

      const readCatalog = async () => {
        const response = await ctx.remote.session.modelCatalog()
        if (!response.ok) throw new Error(response.error?.code ? `${response.error.code}: ${response.error.message}` : 'modelCatalog failed')
        return response.value.groups
      }

      const controller = new RouterController(form, readCatalog)
      ctx.effect(() => () => {
        controller.disposed = true
        controller.unsubscribeForm?.()
      }, 'provider-router: controller')

      ctx.effect(() => {
        const offAdapters = ctx.remote.$on('llm/adapters-updated', () => void controller.load())
        const offSettings = ctx.remote.$on('settings/document-updated', ns => {
          if (ns !== NS) void controller.load()
        })
        return () => {
          offAdapters()
          offSettings()
        }
      }, 'provider-router: catalogue invalidation')

      const t = ctx.locale.bind(NS)
      const injected = () => ({ controller, t })

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: NS,
                  order: 12,
                  label: () => t('nav'),
                  inject: injected,
                },
                RouterPanel,
              ),
            ),
          ),
        'provider-router: settings section',
      )
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})