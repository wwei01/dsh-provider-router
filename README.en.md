# dsh-provider-router

DeepSeek Harness plugin: **one agent tool plus a checkable list**, letting the main model running a conversation borrow third-party models owned by your other attached providers whenever it likes — repeating, batching any combination it chooses — without ever disturbing the main channel.

## Install

Requirements: DSH ≥ 0.2.0-rc.1 and Node.js ≥ 22.19 (the bundle is plain ESM, no build step).

From this repository:

```sh
# latest on the default branch
dsh plugin add github:wwei01/dsh-provider-router

# or pin an exact release
dsh plugin add github:wwei01/dsh-provider-router#v0.4.2
```

The Plugin Manager page offers the same `github:` spec in its **Add plugin** flow. Installing mounts one Host row (`provider-router`) that registers:

- the **`router_call`** agent tool, visible to every Agent in the profile;
- a **Settings → Provider Router** section listing every third-party model under your attached providers, each with a toggle switch and a remaining-token quota input.

Nothing appears in the model selector; nothing writes to any provider configuration or credential store. Uninstalling deregisters both and leaves no state behind.

## What it solves

DSH itself has no setting that lets provider A call a third-party model attached under provider B; a session can switch models wholesale, but never borrow beside its lane. This plugin registers no virtual route and adds nothing to the model selector. It does exactly this:

1. **Fetches your currently available model list automatically**: every third-party model under every attached provider.
2. **Checkboxes control callability**: one independent checkbox per model on the settings page decides which models may be called further.
3. **The parent calls repeatedly, as it likes**: via `router_call`. P→C1, then P→C2, then P→C1+C3… in any sequence, each time decided by the parent which task-related information to pass in (`task` plus optional `materials`; callees see no other conversation history). A call is a mapping: input information → the model → returned packages; the parent then gets exactly what one call produced and summarizes itself.
4. **Remaining-token quotas**: one manually maintained quota box per model (negative = unlimited, one-click reset-all, individually editable). The parent sizes each subtask against these balances when splitting work.

Calling itself is excluded by hard rule: the model the conversation itself runs on is never in the callable set.

## Usage

1. After install the section appears at **Settings → Provider Router** (reads every attached provider's models automatically).
2. Tick the callable models with toggle switches (click flips state and the visual follows immediately — native-checkbox lag is deliberately avoided). **The provider switch follows OR logic**: it is ON whenever any model under that provider is checked, and OFF only when every one is unchecked. Clicking the group switch acts on the whole provider: ON checks every model at once; OFF clears all of that provider's entries (pins included).
3. Each row carries a remaining-token **number input** showing the raw stored value: default -1 (negative = unlimited; that mapping is backend-only); commit on blur or Enter; once positive, each call deducts live and exhausted targets are skipped with a note in the return. A toolbar button resets all quotas to unlimited (-1) in one click — two-step confirm, since this webview blocks native dialogs.
4. New upstream APIs: add the provider under Settings → Models first; it becomes checkable here afterwards (no credentials stored on this panel).
5. The same list exists in YAML at `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (same source as the settings page; hot-editable both ways):

```yaml
- id: provider-router
  name: 'dsh-provider-router'
  config:
    routes:
      - source: qiniuyun                # attached provider route id
        model: moonshotai/kimi-k3       # exact model id; '*' for the whole group
        enabled: true
        quota: -1                        # remaining tokens; -1 = unlimited
```

## How the parent uses it

It calls the tool directly: a self-contained `task`, optional `materials` (evidence array), optional `targets` (virtual ids like `qiniuyun::moonshotai/kimi-k3`; omit for all checked non-self models). Every target returns one verdict: status + verbatim text + tokens used this call + remaining quota. The parent sizes its next subtask and picks targets from those balances.

## Semantics and limitations (stated honestly)

- Callees see only `task`/`materials`, never the rest of the conversation — independent, but key context must be put into `materials`.
- Replay state does not cross adapters: calls go out as plain-text requests; native cache/thinking continuity degrades; content is lossless.
- Quotas are a manual ledger: consumption is process-local (reset across restarts) while the configured values persist; cost ≈ input+output tokens of that request.
- Cost scales with target fan-out per call; each target carries its own 120-second deadline, so a hanging endpoint fails only itself instead of stalling the whole batch.
- schemastery and cosmokit are vendored in `vendor/` under their MIT licenses because this bundle lives outside the profile tree.
- Nothing appears in the selector — no clutter; uninstall leaves nothing behind.

## Uninstall

Removing the bundle deregisters the tool; existing sessions are unaffected.