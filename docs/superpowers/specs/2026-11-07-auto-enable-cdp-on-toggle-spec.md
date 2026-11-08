# Auto-Enable CDP on Toggle — Technical Specification
## 1. Scope and constraints
- Implement the approved design dated 2026-11-07, revision 12.
- CDP remains the only click mechanism; no ad blocking or video manipulation.
- Preserve the existing ad detector, selectors, mouse-event sequence, click retry behavior, and popup layout.
- Add no manifest permission. Keep `minimum_chrome_version` at `96`.
- Do not add a whole-extension test framework or dependencies.
## 2. Interfaces
### 2.1 Types
```ts
type PublicState = "off" | "attached" | "blocked";
type InternalState = PublicState | "attaching" | "draining";
type AttachCode = "UNAVAILABLE" | "NO_TARGET" | "OTHER";
type CdpValue = { state: PublicState; reason: string | null; at: number };
type AttachResult = { ok: true } | { ok: false; code: AttachCode; message: string };
type DispatchResult = { ok: true } | { ok: false; message: string };
type Target = { tabId: number; attached: boolean; url: string };
type PageTarget = { attached: boolean } | null;
type TabRecord = {
  state: InternalState; inAd: boolean; attempted: boolean;
  reason: string | null; timer: unknown | null;
  expectDetach: boolean; queue: FIFO;
};
```
### 2.2 `extension/cdp-session.js` exports
```ts
export const DETACH_GRACE_MS: number = 1500;

export function createCdpSession(options: {
  adapter: Adapter;
  timers: Timers;
  publish: (cdp: CdpValue) => void;
  now: () => number;
  graceMs?: number;
}): CdpSession;
```

`Adapter` is injected; the state machine makes no `chrome.*` call, DOM access, clock read, or random choice.

```ts
interface Adapter {
  listTargets(): Promise<Array<Target>>;
  listPageTarget(tabId: number): Promise<PageTarget>;
  attach(tabId: number): Promise<AttachResult>;
  detach(tabId: number): Promise<{ released: boolean }>;
  dispatchClick(
    tabId: number, x: number, y: number, shouldAbort: () => boolean
  ): Promise<DispatchResult>;
}
interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}
```

- `listTargets` returns all page targets, not just YouTube targets. The machine filters by `https://www.youtube.com/*`.
- `detach` reports whether its API operation released; the caller always verifies with `listPageTarget`.
- `dispatchClick` checks `shouldAbort()` between each of `mouseMoved`, `mousePressed`, and `mouseReleased`; it sends no subsequent event after abort.

The returned `CdpSession` contract:

```ts
interface CdpSession {
  setEnabled(enabled: boolean, options?: { silent?: boolean }): Promise<void>;
  reconcile(): Promise<void>;
  documentBoundary(tabId: number): Promise<void>;
  publishAggregate(): Promise<void>;
  adState(tabId: number, payload: { inAd: boolean }): Promise<void>;
  click(tabId: number, x: number, y: number): Promise<{ ok: boolean; message?: string }>;
  handleDetach(tabId: number): Promise<void>;
  handleTabRemoved(tabId: number): Promise<void>;
  status(tabId: number): { state: PublicState; reason: string | null };
}
```

`status` projects the record's public state: `attaching` publishes as `off`; `draining` publishes as `attached`. A missing record is not a tracked tab.
### 2.3 `extension/status.js` export
```ts
export function deriveStatus(input: {
  enabled: boolean;
  cdp: CdpValue;
}): {
  state: "active" | "limited" | "paused";
  word: "Active" | "Limited" | "Paused";
  reason: string | null;
};
```

Mapping: disabled → `paused` / `Paused` / `null`; enabled and blocked → `limited` / `Limited` / exact `cdp.reason`; enabled and off or attached → `active` / `Active` / `null`.
### 2.4 Chrome API boundary
The background adapter is the only owner of debugger operations. Use callback forms for `chrome.debugger` and read `chrome.runtime.lastError` inside each callback; wrap results as adapter promises. Rejections or `lastError` must not be mistaken for successful detach. Use the Promise form explicitly specified for storage hydration and writes. Event registration callbacks are synchronous registrations; event payloads are listed below.

| API call | Form and input | Result / error surface |
|---|---|---|
| `chrome.storage.local.get({ enabled: true })` | Promise; module-start hydration | Resolves to stored values, with an absent key defaulting to `true`. A rejection is **not** the same as an absent key: retry up to 3 times, then fail closed to `enabled=false` **without any publication of its own**, continuing the normal §5.1 sequence (§11 R3). |
| `chrome.storage.local.set({ cdp })` | Promise; background aggregate publication | Rejection is non-fatal (§11 R3): log once, keep session state, retry on the next aggregate change. Never blocks CDP work and never changes session state. |
| `chrome.storage.onChanged.addListener(listener)` | Listener `(changes, areaName)` | No return value or callback error. Handle the `local` area and `enabled` change. |
| `chrome.debugger.getTargets(callback)` | Callback `(targets)` | Read `chrome.runtime.lastError`; return an adapter rejection, never an empty-success substitute. On rejection the session changes no state and publishes no error value; reconciliation still completes and the mandated hydration write still runs (§11 R3). |
| `chrome.debugger.attach({ tabId }, "1.3", callback)` | Callback with no value | `runtime.lastError` is a refusal; normalize to `UNAVAILABLE`, `NO_TARGET`, or `OTHER`, and return `AttachResult`. |
| `chrome.debugger.detach({ tabId }, callback)` | Callback with no value | `runtime.lastError` yields `{released:false}`; otherwise `{released:true}`. In either case verify target state. |
| `chrome.debugger.sendCommand({ tabId }, method, params, callback)` | Callback `(result)`; methods are only the three mouse events | `runtime.lastError` or command rejection yields `{ok:false,message}`. Do not send an ownership probe. |
| `chrome.debugger.onDetach.addListener(listener)` | Listener `(source, reason)` | Route `source.tabId` through `handleDetach`; distinguish intentional via `expectDetach`, not by guessing `reason`. |
| `chrome.tabs.onUpdated.addListener(listener)` | Listener `(tabId, changeInfo, tab)` | Only `changeInfo.status === "loading"` enqueues `documentBoundary(tabId)`; do not read `url`. |
| `chrome.tabs.onRemoved.addListener(listener)` | Listener `(tabId, removeInfo)` | Route tab ID through `handleTabRemoved`; never detach a removed tab. |
| `chrome.runtime.onMessage.addListener(listener)` | Listener `(message, sender, sendResponse)` | Await `readyPromise` before session access; route `adskip:adState` and `adskip:click`. Because the response is produced after an `await`, the listener **must return `true` synchronously** to keep the channel open — `minimum_chrome_version` is 96, so the Promise-returning listener form is not available (review 1 finding 4). `adState` returns `false` and sends nothing; `click` returns `true` and responds with `{ok, message?}` (§11 R6). Invalid payloads are dropped with no response (§11 R8). |
| `chrome.runtime.sendMessage(message)` | Content-to-background, no callback, for `adskip:adState` | Fire-and-forget. Ignore `lastError`; log once per ad on first transport failure (§11 R6). |
| `chrome.runtime.sendMessage(message, callback)` | Content-to-background callback form, for `adskip:click` | Click response is `{ok, message?}`; treat `runtime.lastError` as a failed click. |
| `chrome.tabs.query({ url })` | Promise; `url: "https://www.youtube.com/*"` for the hello broadcast | Covered by the existing `host_permissions`; no `tabs` permission is added (§11 R7). Rejection → log and skip the broadcast. |
| `chrome.tabs.sendMessage(tabId, message)` | Promise; background-to-content `adskip:hello` | A rejection whose message contains `Receiving end does not exist` means no content script; ignore it, do not retry, and never treat it as an attach failure (§11 R7). |
| `chrome.storage.local.get(keys, callback)` | Popup read on open | Read `runtime.lastError`; popup derives status from `enabled` and `cdp`. |
| `chrome.storage.local.set(items, callback)` | Popup writes its existing toggle keys | Read `runtime.lastError`; do not write `cdp` from popup. |
| `chrome.storage.onChanged.addListener(listener)` | Popup/content listener `(changes, areaName)` | No return value or callback error; popup rerenders, content handles existing keys. |

No `chrome.management` call is part of this design. Extension names may be troubleshooting suggestions prefixed `possibly:` in debug/console output only.
## 3. Data and message contracts
### 3.1 Storage
```json
{
  "cdp": {
    "state": "off | attached | blocked",
    "reason": "string | null",
    "at": 1762500000000
  }
}
```

- `cdp` is background-written and represents the aggregate across tracked YouTube tabs.
- `at` is a millisecond timestamp supplied through injected `now()`. It is **refreshed on every write**: it records when the currently stored aggregate was produced (ruling R5).
- Existing `enabled`, `stats`, `today`, and `debugOverlay` keys and their owners remain unchanged.
- Aggregate priority: any blocked tab → `blocked`, with the reason of the record having the **greatest `blockedAt`**; ties broken by **lowest `tabId`**. Else any attached tab → `attached`; else `off`. Both the ordering field and the tie-break are required — with neither, the aggregate would be implementation-defined (review 1 finding 3).
- Write on aggregate change only, except hydration always republishes once after reconciliation.
### 3.2 Per-tab and session-global data
| Field | Domain and meaning |
|---|---|
| `state` | `off`, `attaching`, `attached`, `draining`, `blocked`; internal state of this tab. |
| `inAd` | Boolean; latest accepted content lifecycle value. |
| `attempted` | Boolean; autonomous attach already tried in the continuous ad. Clear on `inAd:false`, document boundary, and disable. |
| `reason` | Exact current blocked reason, otherwise `null`. |
| `blockedAt` | Integer ms from injected `now()`, set when the record enters `blocked` and cleared when it leaves. It is the only ordering field, and it exists so the aggregate can select the *most recent* blocking reason deterministically (review 1 finding 3). |
| `timer` | Grace timer handle while draining; otherwise `null`. |
| `expectDetach` | Boolean; suppresses an intentional detach's external-detach classification. |
| `queue` | One FIFO per tab for lifecycle inputs, clicks, teardown, timer events, and adapter completions. |
| `enabled` | Session-global Boolean; flips immediately on storage change, outside queued teardown. |
| `disableEpoch` | Session-global monotone integer; increment on each transition to disabled; never decremented. |

A tab removed from the browser is forgotten. There is no generation counter, ad ID, lifetime token, ownership adoption, or persistent per-tab record.
### 3.3 Messages
| Direction | Type | Required payload | Meaning |
|---|---|---|---|
| Content → background | `adskip:adState` | `{ inAd: boolean }` | Idempotent edge or heartbeat; no ad identifier. |
| Content → background | `adskip:click` | `{ x: number, y: number }` | Viewport coordinates of the existing skip-button center. |
| Background → content | `adskip:hello` | No payload specified | Sent to YouTube tabs after hydration so content re-reports current `inAd`. |

Content remains the sole authority for `inAd`, using the existing 250 ms poll. It sends a true heartbeat every 2 s while enabled and in an ad; `onAdStart`, `onAdFinish`, and `yt-navigate-finish` only force the next poll/read. No `adskip:disabled` message exists.
## 4. State machine and queue
All per-tab inputs and adapter completions execute in one FIFO to completion. Cross-tab ordering is irrelevant. `enabled` and `disableEpoch` update immediately; the resulting teardown work is queued. A click queued behind an attach dispatches only after the attach settles. A timer callback enqueues `grace elapsed`; it does not detach outside the FIFO. Repeated `inAd:true` is idempotent; repeated `inAd:false` never restarts grace.

| State | Event | Next | Required effect |
|---|---|---|---|
| off | `inAd:true`, attempted=false | attaching | Set attempted; attach. |
| off | `inAd:true`, attempted=true | off | No-op; attempt spent. |
| off | `inAd:false` | off | Clear attempted. |
| off | disable | off | No-op. |
| off | click | attaching | Set attempted; attach then dispatch. |
| off | external detach | off | No-op. |
| off | document boundary | off | Clear attempted. |
| attaching | attach ok | attached | Clear expectDetach; publish. |
| attaching | attach refused | blocked | Keep attempted; publish normalized reason. |
| attaching | `inAd:true` | attaching | No-op; in-flight guard. |
| attaching | `inAd:false` | off | Clear attempted. |
| attaching | disable | off | Clear attempted; detach and verify. |
| attaching | click | attaching | Queue dispatch behind attach; no second attach. |
| attaching | external detach | blocked | Publish `Detached by the browser`. |
| attaching | document boundary | off | Clear attempted; detach and verify if target exists. |
| attached | `inAd:true` | attached | No-op. |
| attached | `inAd:false` | draining | Clear attempted; start grace timer. |
| attached | disable | off | Clear attempted; clear timer; set expectDetach; abort dispatch; detach and verify. |
| attached | external detach | blocked | Publish `Detached by the browser`. |
| attached | click | attached | Dispatch only; do not attach or detach. |
| attached | document boundary | off | Clear attempted; set expectDetach; detach and verify if target exists. |
| draining | `inAd:true` | attached | Cancel timer; set attempted=true. |
| draining | `inAd:false` | draining | No-op; do not restart timer. |
| draining | grace elapsed | off | Set expectDetach; detach and verify. |
| draining | disable | off | Clear timer and attempted; set expectDetach; detach and verify. |
| draining | click | draining | Dispatch; retain timer. |
| draining | external detach | blocked | Cancel timer; publish. |
| draining | document boundary | off | Clear timer and attempted; detach and verify if target exists. |
| blocked | `inAd:true` | blocked | No-op; autonomous attempt spent. |
| blocked | `inAd:false` | off | Clear attempted/reason; detach and verify. |
| blocked | disable | off | Clear attempted/reason; set expectDetach; detach and verify. |
| blocked | click | attaching | Set attempted; attach then dispatch. |
| blocked | external detach | blocked | No-op. |
| blocked | document boundary | off | Clear attempted/reason; detach and verify if target exists. |
| any | tab removed | forgotten | Drop queued work; remove record; never detach; republish aggregate. |

For every detach, read `listPageTarget(tabId)` afterward: `attached:false` → off; still attached → blocked with `Debugger remains attached — owner unknown`; no target → forget/off. A rejected or unverified detach is not ownership evidence. An intentional `onDetach` with `expectDetach=true` yields off/no reason; otherwise it yields blocked with `Detached by the browser`.
## 5. Ordered algorithms
### 5.1 Worker start and hydration

1. At module scope create one `readyPromise`; register message and storage listeners so early events can await it.
2. `await chrome.storage.local.get({ enabled: true })`; default an absent `enabled` key to true.
3. Call `session.setEnabled(enabled !== false, { silent: true })`.
4. Await `session.reconcile()`: enumerate all page targets, track only YouTube URLs, release every pre-existing attached target, verify the detach postcondition, and never adopt or probe.
5. Await unconditional `session.publishAggregate()`; this hydration write is exempt from change-only suppression.
6. Resolve `readyPromise`; only then broadcast `adskip:hello` to YouTube content scripts.
7. Every message handler and `chrome.storage.onChanged` session path awaits `readyPromise` before touching session state.
### 5.2 Document boundary
1. On `chrome.tabs.onUpdated` with `changeInfo.status === "loading"`, enqueue a document boundary for that tab; do not inspect its URL.
2. Drop queued work belonging to the dead document and clear `attempted`.
3. If the tab still exists and `listPageTarget` finds a page target, set `expectDetach`, detach, and verify. If the tab or target is gone, do not detach.
4. End off only after confirmed release or absent target; if still attached, publish blocked with the ownership-neutral reason.
5. A fresh content script's next heartbeat/edge is processed normally. Repeated boundaries are harmless.
### 5.3 Ad-state edge and heartbeat
1. Keep the existing detector and 250 ms poll as the only source of `inAd`.
2. Send `{inAd}` on edge changes; while enabled and true, resend every 2 s.
3. Force a fresh read on player ad events and SPA navigation; do not emit independent event-derived truth.
4. Route every report through the tab FIFO. Ignore true reports while disabled; accept false reports while disabled to clear state.
### 5.4 Click and disable-abort path
1. Reject an incoming click immediately while disabled with `{ok:false,message:"disabled"}`.
2. At dequeue, recheck enabled; drop stale queued clicks with the same result.
3. If attached, dispatch without attaching or detaching. Otherwise serialize one attach before dispatch; do not duplicate an in-flight attach.
4. Capture `epochAtDispatchStart = disableEpoch`; pass `shouldAbort = () => !enabled || disableEpoch !== epochAtDispatchStart` to the adapter.
5. Between the three mouse events and their pauses — **15 ms after `mouseMoved`, 30 ms after `mousePressed`**, identical to today's `background.js` (ruling R9) — stop on true. Do not send a later event. Return `{ok:false,message:"disabled"}` and set `expectDetach` so intentional detach is not misreported.
6. Any click failure returns `{ok:false,message}` and leaves the session blocked. Content retains the existing behavior: reset `cdpAttempted` after failure and retry from polling without a new bound.
7. On each transition to disabled, flip `enabled` immediately, increment `disableEpoch`, and enqueue teardown. Teardown clears timers and attempted state, aborts dispatch, sets expectDetach, detaches each tracked session and verifies; then republish the aggregate.
### 5.5 Tab removal
On `chrome.tabs.onRemoved`, drop queued work, forget the record, and republish aggregate. Do not call detach for a removed tab. A later timer callback for that tab is a no-op.
## 6. Aggregate storage and popup
- Recompute after every map change, including attach, detach, refusal, external detach, disable, and tab removal.
- Priority is blocked (most recent blocking reason), attached, then off.
- `publishAggregate()` writes `{state, reason, at}` to `chrome.storage.local.cdp`; only background writes this key.
- On hydration always issue one write, even when the computed state compares equal to the persisted value.
- Before the first `cdp` key exists, the popup treats it as `{state:"off", reason:null, at:0}` and renders immediately (ruling R4). It never withholds status pending hydration.
- Popup retains the existing row position and neighbors. Add nested word/reason spans; show reason only in Limited state. Active remains enabled and able to act, not currently attached.
- Limited uses the existing row with warning color; do not change layout.
## 7. Failure and retry contract
| Failure/event | Session and exact reason | Retry | Popup |
|---|---|---|---|
| Attach refused, cause not identifiable | blocked; `Debugger unavailable — close DevTools or disable other extensions, then try again` | No autonomous retry during this ad; a later explicit click follows click rules. | Limited; exact reason. |
| No page target yet | blocked; `Debugger unavailable — page still loading` | No autonomous retry during this ad. | Limited; exact reason. |
| Unexpected `onDetach` | blocked; `Detached by the browser` | No autonomous retry during this ad. | Limited; exact reason. |
| Intentional `onDetach` | off; no reason | No retry. | Active if enabled; Paused if disabled. |
| Detach postcondition still attached | blocked; `Debugger remains attached — owner unknown` | No automatic detach retry is specified. | Limited; exact reason. |
| Tab closed | Forget and republish | None; never detach. | Recomputed from remaining tabs. |
| Disabled | Verify teardown and republish | No skip work while disabled. | Paused; no reason. |
| Worker restart | Reconcile by release-never-adopt; heartbeat/hello restores a live ad | Reattach when live-ad report is processed. | Recomputed; no restart-specific reason. |
| Click dispatch failure | Blocked; published reason is the fixed `Debugger unavailable — click could not be delivered`. The adapter's raw message goes to console/debug overlay only (ruling R2). | Content poll retry remains deliberately unbounded. | Limited with that fixed reason. |
| `getTargets` / `listPageTarget` read failure | No state change; no error value invented (R3). Never detach on unknown evidence. Reconciliation completes anyway, so the mandatory hydration/per-change write still happens. | Retried by the next event, heartbeat ≤ 2 s. | Whatever the records contain; `off` if none. |
| Hydration `storage.local.get` failure | Retry ×3, then `enabled=false` **silently** and continue; no separate write (R3). Consent is never assumed, and the aggregate is whatever reconciliation produces. | A later storage change re-reads and may re-enable. | Paused (disabled) from the normal post-reconciliation publish. |
| Aggregate write failure | Non-fatal: keep session state, log once, no `blocked` caused by storage (ruling R3). | Retried on the next aggregate change. | Last successfully stored value. |
| Lifecycle transport failure (`sendMessage` rejects) | No session state change; log once per ad (ruling R6). | Next heartbeat retries naturally. | Unchanged. |
| Invalid message payload | Dropped, one console warning, no state change (ruling R8). | None. | Unchanged. |

Do not identify DevTools or another extension as the owner. Optional names in diagnostics must be prefixed `possibly:` and never appear in the status row.
## 8. Popup status markup contract
Required structure in `popup.html`:

```html
<section class="status" id="status">
  <span class="dot" id="status-dot" aria-hidden="true"></span>
  <span class="status-text" id="status-text">
    <span class="status-word" id="status-word">Active</span>
    <span class="sub" id="status-reason" hidden></span>
  </span>
</section>
```

`popup.html` loads `popup.js` as a module. `popup.js` imports `deriveStatus`, renders word/state/reason, and hides the reason when null. CSS adds `--warn` to dark and light theme blocks, column layout for `.status-text`, `.status-word`, `.status-text .sub`, and `.status.limited .dot`; existing active/paused styling remains.
## 9. Test checklist
### 9.1 T1 — `tests/unit_cdp_session.mjs` (`node --test`)
Use a fresh session per case, fake adapter, fake timers, and captured publications. Each listed assertion is observable through adapter calls, state/reason, or published aggregate.

| # | Setup | Driving inputs | Observable assertion |
|---|---|---|---|
| 1 | off, enabled | `adState(true)` | Exactly one attach. |
| 2 | attached, attempted | Repeat `adState(true)` | No adapter call. |
| 3 | attached | Click `(x,y)` | Dispatch; no attach/detach. |
| 4 | off | Click `(x,y)` | One attach then dispatch. |
| 5 | attached in ad | `false`, then `true` before grace | One attach and one eventual detach overall; rollover retains live session. |
| 6 | attached then draining | `false`; advance grace | Exactly one detach. |
| 7 | attach refuses | `true`, then repeat `true` | Blocked publication; no second autonomous attach. |
| 8 | attached, unexpected detach | `handleDetach` | State blocked. |
| 9 | attached with timer | Disable | Immediate detach path; timer cleared. |
| 10 | tracked tab | `handleTabRemoved` | Record dropped; no detach; aggregate republished. |
| 11 | Two tabs, one blocked and one attached | End blocked tab's ad | Aggregate blocked first, then attached. |
| 12 | attach in progress | Disable queued behind attach | Attach completes; disable detaches/verifies; ends off with no session. |
| 13 | attach in progress | `inAd:false`; advance grace after attach settles | Enters draining, then verified detach; ends off. |
| 14 | attach in progress | Remove tab, then resolve attach | No detach for dead tab; record remains absent. |
| 15 | blocked | `inAd:false`; verify release | Off and reason cleared. |
| 16 | attach in progress | Queue `inAd:false`; resolve attach | Attached then draining; no early release; exactly one attach. |
| 17 | attached/draining | Grace detach then expected `onDetach` | Off, not blocked. |
| 18 | Pre-existing attached target, no record | `reconcile()` | One detach; starts off; no probe command. |
| 19 | Pre-existing target remains attached after detach | `reconcile()` | Blocked with ownership-neutral reason; no owner claim. |
| 20 | attach in progress | Queue false then true; resolve attach | Attached → draining → attached; one attach total. |
| 21 | attach in progress | Queue click; resolve attach | Exactly one attach and one dispatch. |
| 22 | Attached; then simulate worker restart | Repeat heartbeat | Existing attached is no-op; post-restart heartbeat re-establishes session. |
| 23 | Persisted aggregate is stale blocked | Hydrate and reconcile | Aggregate published unconditionally; stale blocked value cleared. |
| 24 | Click queued; disable before dequeue | Drain queue | Click returns `{ok:false,message:"disabled"}`; no dispatch. |
| 25 | Disabled | Send true heartbeat/hello, then false report | No attach for true; false report still accepted. |
| 26 | Reconciliation includes non-YouTube attached page | Reconcile | Non-YouTube target untracked, undetached, and excluded from aggregate. |
| 27 | Enabled, in ad | Disable then re-enable; next `inAd:true` | Attempted was cleared; attaches again. |
| 28 | Dispatch paused between mouse events | Disable while dispatch runs | No later mouse event; abort true; click returns disabled; queued disable detaches/verifies. |
| 29 | Detach returns unreleased; target remains attached | Exercise grace, disable, reconcile paths | Each publishes blocked, never off. |
| 30 | Grace detach in progress | Queue `inAd:true`; complete detach | Passes through off then attaches; new ad not suppressed. |
| 31 | Any record | Exercise each state-changing transition to `off`, then send `inAd:true` | Exactly one new attach occurs, proving `attempted` was cleared. `attempted` is private, so it is observed behaviourally through this follow-up, never read directly. Exclude the `off` + `inAd:true` + `attempted` no-op row. |
| 32 | Refused ad with content script | `onUpdated(status:"loading")`; fresh `inAd:true` | Queue cleared, attempted cleared, detach verified; fresh ad attaches. |
| 33 | Attaching | External detach | Blocked; no session adopted. |
| 34 | Tab gone or `listPageTarget` returns null | Document boundary | No detach; ends off. |
| 35 | Blocked | Apply false, disable, and document-boundary paths | Each detaches/verifies; off only after release confirmed. |
| 36 | Dispatch checks between events | Disable then re-enable between two mouse events | Epoch change keeps `shouldAbort()` true; third event is not sent. |
### 9.2 T2 — `tests/unit_status.mjs`
For each row, construct the given input, call `deriveStatus`, and deep-equal the full output. In blocked cases, assert the reason is copied verbatim.

| Setup | Input | Observable assertion |
|---|---|---|
| Any CDP state | `enabled:false`, cdp off | Paused / `Paused` / null. |
| Any CDP state | `enabled:false`, cdp attached | Paused / `Paused` / null. |
| Any CDP state | `enabled:false`, cdp blocked with reason R | Paused / `Paused` / null. |
| Enabled | `enabled:true`, cdp off | Active / `Active` / null. |
| Enabled | `enabled:true`, cdp attached | Active / `Active` / null. |
| Enabled | `enabled:true`, cdp blocked with reason R | Limited / `Limited` / exact R. |
### 9.3 T3 — Playwright E2E
- Deterministic, asserted every run: load extension with ES-module background; start worker; observe hydration publish `cdp`; render Active, Limited, and Paused popup states; and observe that a content script emits at least one `adskip:adState` within 3 s of load. `adskip:hello` is one-way and has no reply (ruling R1).
- Best-effort: if YouTube serves an ad, assert console order `attach → click → detach`. When no ad appears in the allotted videos, report exactly `SKIP: no ad served` and pass; do not claim ad-sequence coverage.
### 9.4 T4 and T5
- T4: run `node --check` on every touched JavaScript file before T1–T3.
- T5: render popup in all three states at 300 px and compare the two-line Limited row with the recorded mockup asset after CSS changes.
- T1/T2 are the deterministic state and mapping proof; real ad serving is not deterministic.
## 10. Files changed and documentation updates
- `extension/cdp-session.js` — new state machine, adapter-driven, per-tab FIFO.
- `extension/status.js` — new pure status view-model.
- `extension/background.js` — rewrite for hydration, reconciliation, adapter, router, aggregate `cdp` key.
- `extension/content.js` — single adState edge/heartbeat stream and click transport; no session decisions.
- `extension/manifest.json` — set background `type` to `module`; no permission or minimum-version change.
- `extension/popup/popup.js` — render three states through `status.js`.
- `extension/popup/popup.html` — nested status markup and module script.
- `extension/popup/popup.css` — warning color and two-line status styling.
- `tests/unit_cdp_session.mjs` — T1, 36 cases.
- `tests/unit_status.mjs` — T2.
- `tests/test_adskip.py` — T3 hydration/status and best-effort sequence.
- `AGENTS.md` — update §4 lifecycle, §5 storage key, and §8 edge cases.
- `README.md` — document behavior and add `cdp` to the exact storage/privacy key list.
- `TESTING.md` — add unit/E2E commands and the nondeterministic ad-serving limitation.
- `docs/superpowers/specs/2026-11-07-auto-enable-cdp-on-toggle-spec.md` — this specification.
## 10a. Test scope (design non-goal N3)
Design §3 N3 excludes "a unit-test framework for the extension as a whole", and design §9.2
explicitly requires T2. Read together, N3 forbids building a general harness or mocking
chrome APIs broadly; it does not forbid the two named test files for the two new **pure**
modules, which need no chrome mock at all. T1 and T2 are therefore in scope, and no other
unit test was added under the original scope. This is a reading of the approved design, not a change to it (spec
review 1, finding 6). A third pure-module test file, `tests/unit_background_adapter.mjs`,
was added under a PM amendment dated 2026-11-08.

## 11. PM rulings on the drafter's open questions

Nine questions were left open by the drafter. All are mechanism decisions owned by the PM,
so they are ruled here and folded into the sections above. None reopens the approved design.

| ID | Question | Ruling |
|---|---|---|
| R1 | Is `adskip:hello` request/reply? | **One-way.** Background sends it to YouTube tabs after hydration; it expects no reply. It exists only to nudge a content script into re-sending its current `inAd`. The observable handshake assertion is "a content script emits ≥ 1 `adskip:adState` within 3 s of load". |
| R2 | Which reason shows for a failed `dispatchClick`? | Fixed user-facing reason `Debugger unavailable — click could not be delivered`. The adapter's raw `message` is console/debug-overlay only, never the status row. |
| R3 | Behaviour when a Chrome boundary fails? (A read failure may never suppress a mandated aggregate write; it only forbids inventing an error value.) | **Hydration `storage.local.get` failure: fail closed, silently.** Distinguish a *failed read* from an *absent key*: an absent key means the documented default `true`, but a failed read means consent is unknown, so retry up to 3 times and, if it still fails, set `enabled = false` **with no special publication at all** and log. Hydration then continues through the ordinary §5.1 sequence, so the only write is the normal post-reconciliation `publishAggregate()`. Writing `off` here as well would either precede reconciliation or contradict the detach postcondition, which can legitimately require `blocked` (review 2). `readyPromise` still resolves, so the session gates work as disabled rather than hanging or attaching without consent (review 1). **`getTargets`/`listPageTarget` failure: no state change and no error-state publication** — leave the record exactly as it was, log, and let the next event (heartbeat ≤ 2 s) retry. Publishing a *global error value* was wrong: the aggregate is derived from records, so an unrepresented `blocked` state cannot exist (review 1 finding 2). This forbids inventing an aggregate value; it never suppresses a mandated write. Reconciliation therefore **contains** a read failure rather than rejecting: the affected target is treated as "no information" (its record is left unchanged), reconciliation always completes, and the unconditional post-reconciliation hydration write (§5.5) and the readiness/`hello` sequence both still happen — reporting whatever the records actually contain (an empty map publishes `off`) (review 3). **Aggregate write failure: non-fatal** — keep session state, log once, retry on the next change. |
| R4 | Popup before the first `cdp` key exists? | Treat absence as `{state:"off", reason:null, at:0}` and render immediately. Never withhold status waiting for hydration. |
| R5 | Is `at` refreshed per write or retained? | Refreshed on **every** write: it timestamps the write that produced the stored aggregate. |
| R6 | Does `adskip:adState` need a response? | **No.** Fire-and-forget, no callback, `lastError` ignored for lifecycle messages with a single console log per ad on first failure. `adskip:click` keeps its callback and requires a response. |
| R7 | How are YouTube tabs enumerated for hello without new permissions? | `chrome.tabs.query({ url: "https://www.youtube.com/*" })` in Promise form — permitted by the existing `host_permissions`, so `minimum_chrome_version` and the permission set are unchanged. `chrome.tabs.sendMessage(tabId, msg)` rejection containing `Receiving end does not exist` means no content script: ignore, do not retry, never an attach failure. |
| R8 | Behaviour for invalid payloads? | Drop the message, emit one console warning, change no state. `adState` requires a boolean `inAd` plus `sender.tab.id`; `click` requires finite numeric `x` and `y` plus `sender.tab.id`. |
| R9 | Exact dispatch pause durations? | **15 ms** after `mouseMoved` and **30 ms** after `mousePressed` — byte-for-byte the current `background.js` behaviour, so the mouse-event sequence is unchanged (design N1). |
