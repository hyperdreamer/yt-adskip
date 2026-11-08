# Auto-Enable CDP on Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Keep YouTube's CDP skip-click path available across enable/disable toggles while reporting a truthful aggregate debugger status in the popup.

**Architecture:** Put all per-tab lifecycle, attach, detach, click, reconciliation, and aggregate decisions in a Chrome-independent `cdp-session.js` state machine with injected adapter and timer interfaces. Keep Chrome API ownership in the background worker, ad truth in the content script, and popup wording in the pure `status.js` view-model. Add focused native Node unit tests and extend the existing Playwright E2E test without introducing a general extension test framework.

**Tech Stack:** Manifest V3 Chrome extension; vanilla JavaScript ES modules; Node's built-in `node:test`; existing Python/Playwright E2E harness.

## Global Constraints

- CDP remains the only click mechanism; do not block ads or manipulate video playback.
- Preserve the existing ad detector, skip selectors, mouse-event sequence, click retry behavior, and popup layout.
- Add no manifest permission; keep `minimum_chrome_version` at `96`.
- Do not add a whole-extension test framework, build tooling, or external dependencies.
- Keep the extension free of tracking.

## Task 1: Implement the CDP session state machine and T1 tests
**Implementer tier:** Advanced
Lane: session-core
Depends on: none

**Files:**
- Create: `extension/cdp-session.js`
- Create: `tests/unit_cdp_session.mjs`

**Interfaces:**
- Consumes only the injected `Adapter`, `Timers`, `publish(CdpValue)`, `now()`, and optional `graceMs`; the module must make no `chrome.*` call, DOM access, direct clock read, or random choice.
- Produces `DETACH_GRACE_MS = 1500` and `createCdpSession({ adapter, timers, publish, now, graceMs })`, returning `setEnabled(enabled, { silent? })`, `reconcile()`, `documentBoundary(tabId)`, `publishAggregate()`, `adState(tabId, { inAd })`, `click(tabId, x, y)`, `handleDetach(tabId)`, `handleTabRemoved(tabId)`, and `status(tabId)` as specified below.
- Use `PublicState = "off" | "attached" | "blocked"`, `InternalState = PublicState | "attaching" | "draining"`, `AttachCode = "UNAVAILABLE" | "NO_TARGET" | "OTHER"`, `CdpValue = { state: PublicState; reason: string | null; at: number }`, `AttachResult = { ok: true } | { ok: false; code: AttachCode; message: string }`, `DispatchResult = { ok: true } | { ok: false; message: string }`, `Target = { tabId: number; attached: boolean; url: string }`, and `PageTarget = { attached: boolean } | null`.
- The adapter contract is `listTargets(): Promise<Target[]>`, `listPageTarget(tabId): Promise<PageTarget>`, `attach(tabId): Promise<AttachResult>`, `detach(tabId): Promise<{ released: boolean }>`, and `dispatchClick(tabId, x, y, shouldAbort): Promise<DispatchResult>`. Timers expose `set(fn, ms)` and `clear(id)`.
- A tracked tab record contains `state`, `inAd`, `attempted`, `reason`, `blockedAt`, `timer`, `expectDetach`, and a FIFO queue. `blockedAt` is set from injected `now()` on entry to blocked and cleared on exit. No generation counter, ad ID, lifetime token, ownership adoption, or persistent per-tab record.

**Implementation steps:**
- [ ] Step 1: Build a fresh-session test fixture using `node:test`, a controllable fake adapter, fake timers, deferred adapter promises, and captured publications. Keep each case isolated and assert observable calls, returned results, public state, reasons, and aggregate values rather than private fields.
- [ ] Step 2: Implement one FIFO per tab. Lifecycle inputs, clicks, teardown, grace events, and adapter completions must be serialized to completion. A click behind an attach waits for its result; tab removal drops queued work and late timer callbacks become no-ops. `enabled` and monotone `disableEpoch` change immediately outside queued teardown.
- [ ] Step 3: Implement this complete transition table:
  - `off`: `inAd:true` with `attempted=false` enters `attaching`, sets attempted, and attaches; `inAd:true` with attempted true is a no-op; `inAd:false` clears attempted; disable is a no-op; click enters attaching and performs one attach; external detach is a no-op; document boundary clears attempted and stays off.
  - `attaching`: attach success enters attached, clears `expectDetach`, and publishes; refusal enters blocked and publishes its normalized reason while keeping attempted; repeated true is a no-op; false enters off and clears attempted; disable enters off, clears attempted, then detaches and verifies; click queues dispatch behind the current attach without a second attach; external detach enters blocked with `Detached by the browser`; document boundary enters off, clears attempted, and detaches/verifies if a page target exists.
  - `attached`: repeated true is a no-op; false enters draining, clears attempted, and starts one grace timer; disable enters off, clears attempted and timer, sets `expectDetach`, aborts active dispatch, then detaches/verifies; external detach enters blocked with `Detached by the browser`; click dispatches without attach or detach; document boundary enters off, clears attempted, sets `expectDetach`, and detaches/verifies if a page target exists.
  - `draining`: true cancels the timer, enters attached, and sets attempted true; repeated false does not restart grace; grace elapsed enters off, sets `expectDetach`, and detaches/verifies; disable enters off, clears timer and attempted, sets `expectDetach`, then detaches/verifies; click dispatches while retaining the timer; external detach cancels the timer and enters blocked; document boundary enters off, clears timer and attempted, and detaches/verifies if a target exists.
  - `blocked`: true is a no-op because the autonomous attempt is spent; false enters off, clears attempted/reason, and detaches/verifies; disable enters off, clears attempted/reason, sets `expectDetach`, and detaches/verifies; click enters attaching and retries attach then dispatch; external detach is a no-op; document boundary enters off, clears attempted/reason, and detaches/verifies if a target exists.
  - Any state on tab removal forgets the tab, drops queued work, never detaches the removed tab, and republishes the aggregate. Ignore true reports while disabled, but accept false reports to clear state.
- [ ] Step 4: Make every detach call `listPageTarget(tabId)` afterward, regardless of the detach result. Confirmed `attached:false` means off; a still-attached target means blocked with `Debugger remains attached — owner unknown`; no target means forget/off. A failed or unknown read leaves state unchanged and never invents an error or proves release. Intentional detach `onDetach` is recognized only via `expectDetach`; otherwise publish blocked with `Detached by the browser`.
- [ ] Step 5: Implement release-never-adopt reconciliation: enumerate all targets, consider only `https://www.youtube.com/*`, release every pre-existing attached YouTube target, verify release, and never adopt or issue an ownership probe. Non-YouTube targets remain untouched and excluded. Contain target-read failures without changing records so reconciliation completes.
- [ ] Step 6: Implement document boundaries by dropping queued work for the old document, clearing attempted, and detaching/verifying only if the tab still has a page target. Missing tabs/targets end off without detach. Repeated boundaries are harmless and the next content report is processed normally.
- [ ] Step 7: Implement the 1500 ms default grace period, queue timer callbacks as `grace elapsed`, and make repeated `inAd:false` idempotent. A fresh `inAd:true` before expiry retains the live session.
- [ ] Step 8: Implement disable-abort semantics. Each transition to disabled immediately increments `disableEpoch`; dispatch captures its starting epoch and receives `shouldAbort = () => !enabled || disableEpoch !== epochAtDispatchStart`. Once true, no subsequent mouse event is allowed, even if the session is re-enabled. Clear timers and attempted state and verify each teardown detach.
- [ ] Step 9: Implement public status projection (`attaching` -> `off`, `draining` -> `attached`) and aggregate publication. Priority is blocked, then attached, then off. For blocked records choose greatest `blockedAt`, with ties resolved by lowest `tabId`. Refresh `at` using injected `now()` on every actual write; publish only on aggregate change except the explicit unconditional `publishAggregate()` used by hydration.
- [ ] Step 10: Normalize attach refusal to the exact user-facing reasons: `NO_TARGET` -> `Debugger unavailable — page still loading`; other refusal -> `Debugger unavailable — close DevTools or disable other extensions, then try again`. A click-dispatch failure blocks with `Debugger unavailable — click could not be delivered`; keep the adapter's raw message out of status. A failed click returns its message and content-side polling may retry without a new bound.

**Tests and checks:**
Run `node --check extension/cdp-session.js` and `node --check tests/unit_cdp_session.mjs` before `node --test tests/unit_cdp_session.mjs`; all 36 T1 behaviors below must be covered by named assertions, with fake adapters/timers and no browser or Chrome mock dependency:
1. `off + true` makes exactly one attach.
2. Repeated true while attached/attempted makes no adapter call.
3. Attached click dispatches without attach or detach.
4. Off click performs one attach then dispatch.
5. False then true before grace retains the live session; a later completed ad produces only one detach overall.
6. False followed by grace expiry detaches exactly once.
7. Refusal blocks and repeated true does not autonomously attach again.
8. Unexpected detach while attached becomes blocked.
9. Disable with a grace timer clears it and takes the immediate verified detach path.
10. Tab removal drops the record, never detaches, and republishes aggregate.
11. With one blocked and one attached tab, aggregate is blocked; after blocked tab's ad ends, aggregate is attached.
12. Disable queued during attach waits for attach, detaches/verifies, and ends off.
13. False during attach, followed by attach completion and grace expiry, drains and verifies detach.
14. Removing during attach then resolving attach never detaches the dead tab and leaves no record.
15. Blocked false plus confirmed release clears reason and ends off.
16. False queued during attach applies after attach, enters draining, and does not cause a second attach or early release.
17. Grace detach followed by expected `onDetach` stays off rather than becoming blocked.
18. Reconcile of a pre-existing attached target with no record detaches it without a probe.
19. A pre-existing target that remains attached after detach becomes blocked with the ownership-neutral reason.
20. False then true queued during attach yields attached -> draining -> attached with one attach total.
21. Click queued during attach dispatches after settle with exactly one attach and one dispatch.
22. A new session releases a pre-existing attachment during reconcile; a later heartbeat re-establishes the live ad session, while a repeated heartbeat on an already attached session is a no-op.
23. Hydration/reconcile unconditionally publishes and clears a stale blocked aggregate when no tracked record is blocked.
24. A click disabled before dequeue returns `{ ok: false, message: "disabled" }` and never dispatches.
25. Disabled true/hello causes no attach, while false is still accepted.
26. Reconcile leaves a non-YouTube attached target untouched, untracked, and out of aggregate.
27. Disable then re-enable clears attempted so the next true report attaches again.
28. Disable during dispatch stops later mouse events, returns disabled, and queues verified teardown.
29. Unreleased detach with target still attached stays blocked in grace, disable, and reconcile paths.
30. True queued during grace detach runs after confirmed off and starts a fresh attach.
31. Exercise each state-changing route to off, then true; verify behaviorally that a new attach occurs and do not inspect private attempted state.
32. Loading document boundary after refusal clears old queued/attempted state and lets fresh true attach.
33. External detach while attaching becomes blocked without adopting a session.
34. Missing tab or null page target at document boundary causes no detach and ends off.
35. Blocked false, disable, and document-boundary paths all verify release and become off only after confirmation.
36. Disable then re-enable between mouse events leaves the captured epoch abort predicate true and prevents the third event.

**Commit:**
- [ ] Step 11: Commit: run `git add extension/cdp-session.js tests/unit_cdp_session.mjs && git commit -m "feat: add serialized CDP session state machine"`.

## Task 2: Add the pure status view-model and T2 tests
**Implementer tier:** Standard
Lane: status
Depends on: none

**Files:**
- Create: `extension/status.js`
- Create: `tests/unit_status.mjs`

**Interfaces:**
- Consumes `CdpValue = { state: "off" | "attached" | "blocked"; reason: string | null; at: number }` as input data only.
- Produces `deriveStatus({ enabled, cdp }) -> { state: "active" | "limited" | "paused"; word: "Active" | "Limited" | "Paused"; reason: string | null }` with no Chrome, DOM, storage, or other side effects.

**Implementation steps:**
- [ ] Step 1: Add `deriveStatus` as a pure function. Disabled always maps to `{ state: "paused", word: "Paused", reason: null }`; enabled plus blocked maps to `{ state: "limited", word: "Limited", reason: cdp.reason }`; enabled plus off or attached maps to `{ state: "active", word: "Active", reason: null }`.
- [ ] Step 2: Add six `node:test` cases that deep-equal the complete result and verify blocked reason copying verbatim; do not add a test framework or Chrome mocks.

**Tests and checks:**
Run `node --test tests/unit_status.mjs`; cover disabled with off, attached, and blocked inputs, plus enabled with off, attached, and blocked inputs. Run `node --check extension/status.js` before the unit test.

**Commit:**
- [ ] Step 3: Commit: run `git add extension/status.js tests/unit_status.mjs && git commit -m "feat: add pure popup status mapping"`.

## Task 3: Wire the background worker and hydration integration
**Implementer tier:** Advanced
Lane: integration
Depends on: 1

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/manifest.json`
- Modify: `tests/test_adskip.py`

**Interfaces:**
- Consumes `createCdpSession` from Task 1 and its `CdpSession` methods. The session adapter is the only code that performs debugger operations.
- Produces the runtime message contracts `adskip:adState` with `{ inAd: boolean }`, `adskip:click` with finite `{ x: number, y: number }`, and one-way background-to-content `adskip:hello`. Validate that every inbound message has `sender.tab.id`; invalid messages are dropped with one warning and no response.
- Produces the background-written storage value `cdp: { state: "off" | "attached" | "blocked", reason: string | null, at: number }` and sets `background.type` to `"module"` without changing permissions or the minimum Chrome version.

**Implementation steps:**
- [ ] Step 1: Implement the injected session adapter using callback forms for `chrome.debugger.getTargets`, `attach`, `detach`, and `sendCommand`; inspect `chrome.runtime.lastError` inside each callback. `listTargets()` returns every page target as `{ tabId, attached, url }`, leaving YouTube filtering to the session; `listPageTarget(tabId)` returns only that tab's page target as `{ attached }` or `null`, and rejects on read error. Never convert target-read failure into an empty success, never treat failed detach as released (`lastError` returns `{ released: false }`), and report `{ released: true }` only when the detach callback has no error. Normalize attach refusal as `NO_TARGET` when no page target exists, `UNAVAILABLE` for debugger-unavailable refusal, and `OTHER` otherwise, preserving the raw message. Send only `Input.dispatchMouseEvent` for `mouseMoved`, `mousePressed`, and `mouseReleased`; do not issue an ownership probe. Between events preserve pauses of 15 ms after move and 30 ms after press, and check `shouldAbort()` between events and pauses.
- [ ] Step 2: At module scope create one `readyPromise` and register storage, debugger, tab, and runtime listeners before hydration. Route `onDetach` to `handleDetach(source.tabId)`; route only `onUpdated` events whose `changeInfo.status === "loading"` to `documentBoundary(tabId)` without reading URL; route `onRemoved` to `handleTabRemoved(tabId)` and never detach a removed tab.
- [ ] Step 3: Hydrate with Promise-form `chrome.storage.local.get({ enabled: true })`. Distinguish absent key (default true) from rejection; retry rejection up to three times, then set enabled false silently without a separate publication and continue. Await silent `setEnabled`, `reconcile`, and one unconditional `publishAggregate()` in that order. Resolve readiness only after these operations, then query YouTube tabs and send one-way `adskip:hello`; ignore missing content receivers and log/skip query rejection.
- [ ] Step 4: Make every message and storage-change path await `readyPromise` before session access. For valid `adskip:adState`, call `adState`, send no response, and return `false`. For valid `adskip:click`, keep the message channel alive by returning `true` synchronously, then await the session result and call `sendResponse({ ok, message? })`; disabled clicks respond `{ ok: false, message: "disabled" }`. Drop invalid payloads without a response or state change. Validate boolean `inAd`, finite numeric coordinates, and tab ID before routing.
- [ ] Step 5: Route `chrome.storage.onChanged` only for the `local` area and `enabled` key. Flip enabled/disable epoch immediately through session control before queued teardown. Preserve ownership of existing `enabled`, `stats`, `today`, and `debugOverlay` keys; popup/content never write `cdp`.
- [ ] Step 6: Connect session aggregate publication to Promise-form `chrome.storage.local.set({ cdp })`, refreshing `at` for every write. On write rejection keep the session state, log once, and retry only on the next aggregate change; storage failure must never create a blocked state or block CDP work. Reconciliation read failures preserve existing records, complete readiness, and still allow the unconditional hydration aggregate write. Broadcast hello with Promise-form `chrome.tabs.query({ url: "https://www.youtube.com/*" })`; a query rejection is logged and skipped, while `tabs.sendMessage` rejection containing `Receiving end does not exist` is ignored without retry and never treated as attach failure.
- [ ] Step 7: Set only `background.type` to `"module"` in the manifest. Preserve the permission array and `minimum_chrome_version: "96"`; add no `chrome.management` call or other permission.
- [ ] Step 8: Extend the existing E2E file with a deterministic worker-load assertion: start the extension worker, observe the post-reconcile `cdp` hydration write, and verify the extension loads with the module service worker. Keep this test deterministic and independent of whether YouTube serves an ad.

**Tests and checks:**
Run `node --check extension/background.js`, parse `extension/manifest.json` as JSON and assert `background.type === "module"`, permissions are unchanged, and minimum version is `96`; run both Node unit suites. Run the deterministic worker hydration test in `tests/test_adskip.py`. Confirm async click response remains available because the listener returns `true` synchronously; no Promise-returning listener form is used.

**Commit:**
- [ ] Step 9: Commit: run `git add extension/background.js extension/manifest.json tests/test_adskip.py && git commit -m "feat: hydrate and route background CDP sessions"`.

## Task 4: Move content lifecycle and click transport to messages
**Implementer tier:** Standard
Lane: content
Depends on: 3

**Files:**
- Modify: `extension/content.js`

**Interfaces:**
- Consumes the background contracts `adskip:adState` `{ inAd }`, `adskip:click` `{ x, y }` with `{ ok, message? }` response, and one-way `adskip:hello`.
- Produces the sole source of ad truth: edge reports plus a true heartbeat every 2 seconds while enabled and in an ad. The existing 250 ms poll remains the detector and click-retry loop; content makes no attach, detach, session, or aggregate decision.

**Implementation steps:**
- [ ] Step 1: Preserve the current `getAdState`/CSS-class detector, skip selectors, 250 ms poll, 1 second grace, and retry behavior. Remove local session-ownership decisions; retain only content-side detection, click-attempt retry state, UI debug overlay behavior, and existing stats behavior.
- [ ] Step 2: Send `{ type: "adskip:adState", inAd }` on detected edge changes and every 2 seconds while enabled and true. Use fire-and-forget `chrome.runtime.sendMessage(message)`; ignore `lastError`, logging only once per ad on the first transport failure. Repeated true heartbeats are idempotent at the background session.
- [ ] Step 3: Keep `onAdStart`, `onAdFinish`, and `yt-navigate-finish` as prompts to force the next detector read only; do not derive or send independent event-based ad truth. Reset edge/heartbeat timing appropriately on navigation and disable so the next poll reports current state.
- [ ] Step 4: For the existing skip-button center coordinates, send `adskip:click` with the callback form. Treat runtime transport errors and `{ ok: false }` as click failures and reset the existing `cdpAttempted` retry guard; successful responses retain existing stats behavior. Do not synthesize DOM clicks or decide whether CDP is attached.
- [ ] Step 5: Handle one-way `adskip:hello` by forcing a fresh detector read/report; send no hello response and do not interpret it as an attach or detach signal. Preserve storage listeners for existing content-owned settings and existing initialization order.

**Tests and checks:**
Run `node --check extension/content.js`, then both Node unit suites and the deterministic E2E coverage available from Task 3. Verify the hello path causes a fresh `adskip:adState` report and that no `adskip:disabled` message or session decision remains in content behavior.

**Commit:**
- [ ] Step 6: Commit: run `git add extension/content.js && git commit -m "feat: report ad lifecycle and forward skip clicks"`.

## Task 5: Render popup status and complete browser E2E coverage
**Implementer tier:** Advanced
Lane: integration
Depends on: 2, 3, 4

**Files:**
- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.js`
- Modify: `extension/popup/popup.css`
- Modify: `tests/test_adskip.py`

**Interfaces:**
- Consumes `deriveStatus({ enabled, cdp })` from Task 2. Missing `cdp` is treated immediately as `{ state: "off", reason: null, at: 0 }`.
- Consumes the existing callback-form popup storage reads/writes and `chrome.storage.onChanged`; read `runtime.lastError`, preserve existing toggle keys, and never write `cdp` from popup code.
- Produces a three-state row: Active, Limited with exact reason, or Paused. Active means enabled and able to act, not that a debugger is currently attached.

**Implementation steps:**
- [ ] Step 1: Replace the status markup with the required nested structure: `section.status#status`, `span.dot#status-dot[aria-hidden=true]`, `span.status-text#status-text`, child `span.status-word#status-word`, and child `span.sub#status-reason[hidden]`. Load `popup.js` with `type="module"`.
- [ ] Step 2: Import `deriveStatus` in `popup.js`; read `enabled` and `cdp` on open, render immediately with the absent-key default, and rerender on local storage changes. Set state classes and word from the view-model, show reason only in Limited, and preserve current toggle writes and neighboring rows.
- [ ] Step 3: Add `--warn` in both dark and light theme blocks. Style `.status-text` as a column, style `.status-word` and `.status-text .sub`, and add `.status.limited .dot`; retain existing active/paused styling and row position/layout.
- [ ] Step 4: Complete deterministic E2E coverage in `tests/test_adskip.py`: load the ES-module extension, observe hydration `cdp`, render Active/Limited/Paused popup states including a two-line Limited reason, and observe at least one content `adskip:adState` within 3 seconds of load. Treat `adskip:hello` as one-way with no reply.
- [ ] Step 5: Keep the ad-sequence E2E best-effort. When YouTube serves an ad, assert console order `attach -> click -> detach`. If no ad appears in the allotted videos, report exactly `SKIP: no ad served` and pass without claiming ad-sequence coverage.
- [ ] Step 6: Render all three popup states at 300 px and compare the two-line Limited row against the canonical recorded mockup once its identity is resolved; do not change the existing layout to accommodate the status reason.

**Tests and checks:**
Before T1-T3, run `node --check` on every touched JavaScript file (extension root JS, `extension/popup/*.js`, and `tests/unit_*.mjs`). Run `node --test tests/unit_cdp_session.mjs tests/unit_status.mjs` and the existing `tests/test_adskip.py` suite. Confirm all three popup states fit at 300 px, the Limited reason is hidden in other states, and the exact no-ad output is `SKIP: no ad served`.

### Resolved by PM
The canonical baseline is a single committed asset, named in design section 4 and already
in the repository:

    docs/superpowers/specs/assets/2026-11-07-popup-status-states.png

It is the record for popup variant B (state word plus muted reason line), rendered at the
real popup geometry (300 px card, 16 px padding, 268 px inner width, `box-sizing:
border-box`). Compare against that file and do not create a second baseline or restyle the
row to match. If the rendered result differs, the CSS is wrong, not the asset.

**Commit:**
- [ ] Step 7: Commit: run `git add extension/popup/popup.html extension/popup/popup.js extension/popup/popup.css tests/test_adskip.py && git commit -m "feat: show CDP status in popup"`.

## Task 6: Update architecture, user, and test documentation
**Implementer tier:** Standard
Lane: docs
Depends on: 1, 2, 3, 4, 5

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `TESTING.md`

**Interfaces:**
- Consumes the implemented contracts from Tasks 1-5: background-owned aggregate `cdp`, content-owned ad lifecycle reports, status values `active`/`limited`/`paused`, and the existing permissions/version floor.
- Produces documentation consistent with the code and signed spec, without changing implementation files or adding additional setup dependencies.

**Implementation steps:**
- [ ] Step 1: Update `AGENTS.md` §4 with the edge/heartbeat lifecycle and click message flow, §5 with the background-owned `cdp` storage aggregate and existing-key ownership, and §8 with reconcile, document-boundary, disable, detach-verification, and failure behavior. Preserve the no-blocking/no-video-manipulation design.
- [ ] Step 2: Update `README.md` to describe CDP status and enable/disable behavior, and add `cdp` to the exact storage/privacy key list with its `state`, `reason`, and `at` fields. Do not claim that Active means currently attached or that ads are blocked.
- [ ] Step 3: Update `TESTING.md` with commands for both native Node unit suites and the existing Playwright/Python E2E suite, the syntax-check-before-T1-T3 requirement, three popup states, and the nondeterministic ad-serving limitation including exact `SKIP: no ad served` wording.
- [ ] Step 4: Check each documented permission, Chrome version, message, storage owner, retry rule, and test claim against the implementation and spec; keep only the three named documentation files changed.

**Tests and checks:**
Review the final diff for those three files only. Verify documented commands match the test files and that no new permission, dependency, build step, or ad-blocking behavior is documented. Run the unit and E2E commands documented in `TESTING.md` and confirm their results match the documentation.

**Commit:**
- [ ] Step 5: Commit: run `git add AGENTS.md README.md TESTING.md && git commit -m "docs: describe CDP session status and tests"`.
