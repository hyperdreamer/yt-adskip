#!/usr/bin/env python3
"""End-to-end test for YT AdSkip Chrome extension.

Uses Playwright to load the extension, navigate to YouTube,
click play via CDP (user gesture), and verify ad-skip pipeline.

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
                    if any(k in msg.text for k in ['SUCCEEDED', 'FAILED']):
                        print(f'    {msg.text}')
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

            # Quick play click if paused
            try:
                await asyncio.sleep(1.5)
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

            # Fast poll: 1.5s intervals, bail after ~9s
            for _ in range(6):
                await asyncio.sleep(1.5)
                if any('SUCCEEDED' in e for e in events):
                    successes += 1
                    print(f' OK ({successes}/10)')
                    break
                if any('FAILED' in e for e in events):
                    print(' FAIL')
                    page.remove_listener('console', on_console)
                    await browser.close()
                    print('\nABORTED after CDP failure')
                    return

            if not any('SUCCEEDED' in e for e in events):
                ad_flag = 'ad' if any('Ad #' in e for e in events) else 'no ad'
                poll_count = sum(1 for e in events if 'polling' in e)
                extra = f', polled {poll_count}x' if poll_count else ''
                print(f' skip ({ad_flag}{extra})')

            page.remove_listener('console', on_console)

        emoji = 'DONE' if successes >= 10 else 'PARTIAL'
        print(f'\n{emoji}: {successes}/10 skips across {tried} videos')
        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
