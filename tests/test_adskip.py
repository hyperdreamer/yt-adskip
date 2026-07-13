#!/usr/bin/env python3
"""End-to-end test for YT AdSkip Chrome extension.

Uses Playwright to load the extension, navigate to YouTube,
click play via CDP (user gesture), and verify ad-skip pipeline.

Strategy:
- If no ad appears in 2s → move to next video immediately
- If an ad IS detected → wait up to 30s for skip pipeline

Usage: python3 tests/test_adskip.py
"""

import asyncio, os
from playwright.async_api import async_playwright

EXT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'extension')
PROFILE_DIR = os.path.join(os.path.dirname(__file__), 'profiles', 'pw-fresh')
VIDEOS = [
    'dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk', 'RgKAFK5djSk',
    'JGwWNGJdvx8', 'OPf0YbXqDm0', 'YQHsXMglC9A', 'fRh_vgS2dFE',
    'CevxZvSJLk8', 'HP-MbfHFUqs', 'kXYiU_JCYtU', 'RBumgq5yVrA',
    'hT_nvWreIhg', '0KSOMA3QBU0', 'nfWlot6h_JM', '2Vv-BfVoq4g',
]

AD_DETECT_TIMEOUT = 2       # seconds to wait for an ad to appear
SKIP_WAIT_TIMEOUT = 30      # seconds to wait for skip pipeline once ad seen


async def cdp_click(cdp, x, y):
    """Real mouse click via CDP — isTrusted: true."""
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseMoved', 'x': x, 'y': y, 'button': 'none', 'buttons': 0})
    await asyncio.sleep(0.05)
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'buttons': 1, 'clickCount': 1})
    await asyncio.sleep(0.03)
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'buttons': 0, 'clickCount': 1})


async def wait_for_ad_or_timeout(page, timeout):
    """Poll until an ad is detected or timeout expires.
    Returns True if ad detected, False if timed out with no ad."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        has_ad = await page.evaluate('''() => {
            const p = document.getElementById('movie_player');
            if (!p) return false;
            if (typeof p.getAdState === 'function' && p.getAdState() !== -1) return true;
            return p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
        }''')
        if has_ad:
            return True
        await asyncio.sleep(0.25)
    return False


async def wait_for_skip_result(events, timeout):
    """Wait for SUCCEEDED or FAILED in console events. Returns 'success', 'fail', or 'timeout'."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if any('SUCCEEDED' in e for e in events):
            return 'success'
        if any('FAILED' in e for e in events):
            return 'fail'
        await asyncio.sleep(0.3)
    return 'timeout'


async def main():
    print(f'Extension: {EXT_PATH}')
    print(f'Profile:   {PROFILE_DIR}')
    print(f'Target: 10 successful CDP skips\n')

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

        successes = 0
        tried = 0

        for vid in VIDEOS:
            if successes >= 10:
                break

            events = []

            def on_console(msg):
                if 'AdSkip' in msg.text:
                    events.append(msg.text)
            page.on('console', on_console)

            tried += 1
            url = f'https://www.youtube.com/watch?v={vid}'
            print(f'[{tried}] {vid}', end='', flush=True)

            try:
                await page.goto(url, wait_until='domcontentloaded', timeout=10000)
            except:
                print(' timeout')
                page.remove_listener('console', on_console)
                continue

            # Click play if paused (pre-roll ads only appear after user gesture)
            try:
                await asyncio.sleep(0.8)
                v = page.locator('#movie_player video').first
                paused = await v.evaluate('el => el.paused')
                if paused:
                    try:
                        box = await page.locator('.ytp-large-play-button').first.bounding_box(timeout=2000)
                        cx = box['x'] + box['width'] / 2
                        cy = box['y'] + box['height'] / 2
                        await cdp_click(cdp, cx, cy)
                    except:
                        pass
            except:
                pass

            # Phase 1: wait up to AD_DETECT_TIMEOUT for an ad to appear
            ad_seen = await wait_for_ad_or_timeout(page, AD_DETECT_TIMEOUT)

            if not ad_seen:
                print(' → next (no ad)')
                page.remove_listener('console', on_console)
                continue

            # Phase 2: ad detected — wait for skip pipeline
            print(f' 📺 ad', end='', flush=True)
            result = await wait_for_skip_result(events, SKIP_WAIT_TIMEOUT)

            if result == 'success':
                successes += 1
                print(f' ✅ SKIPPED ({successes}/10)')
            elif result == 'fail':
                print(' ❌ CDP FAILED')
                page.remove_listener('console', on_console)
                await browser.close()
                print('\nABORTED after CDP failure')
                return
            else:
                poll_count = sum(1 for e in events if 'polling' in e)
                print(f' ⏱ timeout (polled {poll_count}x)')

            page.remove_listener('console', on_console)

        emoji = 'DONE' if successes >= 10 else 'PARTIAL'
        print(f'\n{emoji}: {successes}/10 skips across {tried} videos')
        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
