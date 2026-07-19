# Testing YT AdSkip

End-to-end testing of the CDP-based YouTube ad-skip extension.

## Quick run

```bash
python3 tests/test_adskip.py
```

## Prerequisites

- Python 3 + `playwright` (`pip install playwright`)
- Playwright Chromium (`python3 -m playwright install chromium`)

## How it works

The test script (`tests/test_adskip.py`) uses Playwright to:

1. Launch Chromium with the extension loaded via `launch_persistent_context`
2. Navigate to YouTube videos in sequence
3. Click the video player via CDP (`Input.dispatchMouseEvent`) to trigger pre-roll ads
4. Monitor the extension's console output for the ad-skip pipeline
5. Report success/failure

Test profiles are stored under `tests/profiles/` (git-ignored) for reuse across runs.

## Expected output

Successful run looks like:

```
Extension: .../yt-adskip/extension
Profile:   .../yt-adskip/tests/profiles/pw-fresh
Target: 10 successful CDP skips

[1] dQw4w9WgXcQ 📺 ad ✅ SKIPPED (1/10)
[2] 9bZkp7q19f0 📺 ad ✅ SKIPPED (2/10)
[3] RgKAFK5djSk → next (no ad)
...
[7] fRh_vgS2dFE 📺 ad ✅ SKIPPED (10/10)

DONE: 10/10 skips across 7 videos
```

## What the test verifies

1. Extension loads without errors
2. Content script injects on YouTube pages
3. `movie_player` is hooked
4. Ad detection works (`📺 Ad #1 detected`)
5. Skip button selectors match current YouTube DOM
6. Background service worker receives message and attaches CDP
7. `chrome.debugger.sendCommand` + `Input.dispatchMouseEvent` succeeds
8. Ad ends naturally after click

## Known quirks

- YouTube ad serving is inconsistent in automated Chrome. If no ad appears
  across all videos, the extension may still work — YouTube is withholding
  ads from the automated session.
- `--load-extension` on the plain Chrome CLI is silently ignored. Playwright's
  `launch_persistent_context` + `--disable-extensions-except` is required.
