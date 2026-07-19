# Ignored Audit Findings

These findings were reviewed during the Claude Code audit and deliberately left unfixed because the proposed changes could regress intended ad-skipping behavior or require broader evidence/infrastructure.

## Unbounded CDP retry loop

- **Location:** `extension/content.js` retry handling after a failed `tryCdpClick()`.
- **Reason ignored:** A retry cap or permanent stop could miss a transiently appearing Skip Ad button or prevent recovery after a temporary debugger/extension conflict. The current behavior retries only while the ad remains active and is preferable without measured resource impact or live evidence of harmful churn.
- **Revisit when:** A reproducible persistent-failure case demonstrates unacceptable attach/message churn, warning spam, or service-worker impact; then add a bounded/backoff strategy with tests covering recovery.

## Cross-tab stats read-modify-write race

- **Location:** `extension/content.js:flushStats()`.
- **Reason ignored:** `chrome.storage.local` has no atomic increment primitive. Replacing the current batching with a mutex or another coordination protocol would add complexity and failure modes for a low-impact counter; changing it could lose stats during tab lifecycle events.
- **Revisit when:** Accurate multi-tab accounting becomes a hard requirement and a tested coordination design is available.

## Broad missing unit-test infrastructure

- **Location:** Extension core logic generally; current tests are Playwright/end-to-end oriented.
- **Reason ignored:** Adding a mock Chrome API/test framework is project-level infrastructure work, not a narrowly verified defect, and could introduce a second test environment that diverges from Chrome behavior. The existing end-to-end test remains the source of runtime validation.
- **Revisit when:** The project explicitly adopts a unit-test harness and defines stable Chrome API mocks/coverage goals.

## `cdpAttempted` race across rapid ad-pod transitions

- **Location:** `extension/content.js` `cdpAttempted` state and asynchronous CDP result handling.
- **Reason ignored:** The scenario requires a failed click response to overlap a rapid ad transition; the worst identified result is a duplicate click. A nonce/state-generation fix would alter asynchronous behavior without live evidence that this occurs in practice.
- **Revisit when:** Live instrumentation reproduces a late response clearing the flag for a newer ad instance; then associate responses with an ad-generation nonce and add a regression test.
