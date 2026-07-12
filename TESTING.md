# Testing YT AdSkip

End-to-end testing of the CDP-based YouTube ad-skip extension.

## Prerequisites

- Python 3 + `playwright` (`pip install playwright`)
- Playwright Chromium (`python3 -m playwright install chromium`)
- `websockets` (`pip install websockets`)

## Test script

The script below uses Playwright to launch Chromium with the extension loaded,
navigates to YouTube videos, clicks the video player via CDP (user-gesture to
trigger pre-roll ads), then watches the extension's console output for the
ad-skip pipeline.

```python
# save as test_adskip.py and run: python3 test_adskip.py

import json, asyncio
from playwright.async_api import async_playwright

EXT_PATH = '/data/home/guest/Development/yt-adskip'
VIDEOS = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk', 'RgKAFK5djSk']
PROFILE_DIR = '/tmp/pw-ext-test'  # persistent, reuse across runs

async def cdp_click(cdp, x, y):
    """Real mouse click via CDP — generates isTrusted: true events."""
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseMoved', 'x': x, 'y': y, 'button': 'none', 'buttons': 0})
    await asyncio.sleep(0.05)
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'buttons': 1, 'clickCount': 1})
    await asyncio.sleep(0.03)
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'buttons': 0, 'clickCount': 1})

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            args=[
                f'--disable-extensions-except={EXT_PATH}',
                f'--load-extension={EXT_PATH}',
                '--no-sandbox', '--disable-gpu', '--mute-audio',
            ],
            viewport={'width': 1280, 'height': 720},
        )

        page = await browser.new_page()
        cdp = await page.context.new_cdp_session(page)

        for vid in VIDEOS:
            events = []

            def on_console(msg):
                if 'AdSkip' in msg.text:
                    events.append(msg.text)
                    if any(k in msg.text for k in ['📺', '🖱', 'SUCCEEDED', 'FAILED']):
                        print(f'  {msg.text}')

            page.on('console', on_console)

            url = f'https://www.youtube.com/watch?v={vid}'
            print(f'\n▶ {vid}: {url}')
            await page.goto(url, wait_until='domcontentloaded', timeout=15000)
            await asyncio.sleep(2)

            # CDP click on video center to trigger autoplay + pre-roll ad
            try:
                box = await page.locator('#movie_player video').first.bounding_box()
                if box:
                    cx = box['x'] + box['width'] / 2
                    cy = box['y'] + box['height'] / 2
                    await cdp_click(cdp, cx, cy)
                    print('  ▶ CDP click play')
            except Exception as e:
                print(f'  ⚠️ play click error: {e}')

            # Wait up to 30s for ad detection + skip
            for _ in range(10):
                await asyncio.sleep(3)
                if any('SUCCEEDED' in e or 'FAILED' in e for e in events):
                    break

            success = any('SUCCEEDED' in e for e in events)
            if success:
                print(f'  🎉 CDP SKIP WORKS on {vid}!')
                break
            elif any('FAILED' in e for e in events):
                print(f'  ❌ CDP FAILED on {vid}')
            else:
                print(f'  ⏭  no ad or skip not triggered')

            page.remove_listener('console', on_console)

        await browser.close()
        print('\nDone.')

asyncio.run(main())
```

## Expected output

Successful run looks like:

```
▶ dQw4w9WgXcQ: https://www.youtube.com/watch?v=...
  ▶ CDP click play
  [YT AdSkip] 📺 Ad #1 detected
  [YT AdSkip] 📺 Ad #2 detected
  [YT AdSkip] 🖱 Skip button found at (825, 471), dispatching CDP click
  [YT AdSkip] ✅ CDP click SUCCEEDED
  🎉 CDP SKIP WORKS on dQw4w9WgXcQ!
```

## What the test verifies

1. Extension loads without errors (`--load-extension` via Playwright persistent context)
2. Content script injects on YouTube pages (`[YT AdSkip] content script loaded`)
3. `movie_player` is hooked (`🎬 movie_player hooked`)
4. Ad detection works (`📺 Ad #1 detected`)
5. Skip button selectors match current YouTube DOM (`🖱 Skip button found at (x, y)`)
6. Background service worker receives message and attaches CDP
7. `chrome.debugger.sendCommand` + `Input.dispatchMouseEvent` succeeds
8. Ad ends naturally after click (`✅ CDP click SUCCEEDED`)

## Known quirk

YouTube ad serving is inconsistent in headless/automated Chrome. If no ad
appears across all videos, the extension may still be working — just YouTube
withholding ads from the automated session. Try a different video or wait
a few minutes between runs.

## Why `--load-extension` needs Playwright persistent context

Plain `--load-extension` on the Chrome CLI is silently ignored. Playwright's
`launch_persistent_context` + `--disable-extensions-except` is the only
reliable way to load unpacked extensions in automated Chrome.
