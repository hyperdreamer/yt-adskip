# Testing YT AdSkip

End-to-end testing of the CDP-based YouTube ad-skip extension.

## Unit tests

```bash
node --test tests/unit_cdp_session.mjs
node --test tests/unit_status.mjs
node --test tests/unit_background_adapter.mjs
```

## End-to-end run

```bash
python3 tests/test_adskip.py
```

## Prerequisites

- Python 3
- `playwright` must be installed (`pip install playwright`)
- Playwright Chromium (`python3 -m playwright install chromium`)

`playwright` is not available in this development environment, so the
end-to-end suite is unverified here.

## How it works

The script has a deterministic half and a best-effort live-ad half:

1. Deterministic checks cover extension loading, hydration publishing `cdp`,
   popup status states, and receipt of `adState` within 3 seconds.
2. The live-ad check exercises a YouTube ad when one is served. When YouTube
   serves no ad, the test prints exactly `SKIP: no ad served`.

Test profiles are stored under `tests/profiles/` (git-ignored) for reuse across runs.

## No-ad output

When no ad is served, the best-effort portion prints:

```
SKIP: no ad served
```

## What the test verifies

1. Extension loads and hydration publishes the `cdp` status.
2. Popup renders its status states.
3. The content script reports `adState` within 3 seconds.
4. The best-effort live-ad check exercises the skip path when an ad is served; otherwise it prints exactly `SKIP: no ad served`.

## Known quirks

- YouTube ad serving is inconsistent in automated Chrome. If no ad appears,
  the live-ad portion reports `SKIP: no ad served`; the deterministic checks
  still run.
- `--load-extension` on the plain Chrome CLI is silently ignored. Playwright's
  `launch_persistent_context` + `--disable-extensions-except` is required.
