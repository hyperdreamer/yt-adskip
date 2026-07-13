#!/usr/bin/env python3
"""End-to-end test for YT AdSkip Chrome extension.

Uses Playwright to load the extension, navigate to YouTube,
click play via CDP (user gesture), and verify ad-skip pipeline.

Usage: python3 tests/test_adskip.py
"""

import json, asyncio, os, sys
from playwright.async_api import async_playwright

EXT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'extension')
PROFILE_DIR = os.path.join(os.path.dirname(__file__), 'profiles', 'pw-test')
VIDEOS = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk', 'RgKAFK5djSk']


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
    print(f'Profile:   {PROFILE_DIR}\n')

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

            # Only click to play if video is actually paused
            try:
                await asyncio.sleep(2)  # let page + ads settle
                v = page.locator('#movie_player video').first
                paused = await v.evaluate('el => el.paused')
                
                if paused:
                    # Click the YouTube large play button (center of player)
                    # — clicking the video element directly doesn't work
                    play_btn = page.locator('.ytp-large-play-button').first
                    try:
                        box = await play_btn.bounding_box(timeout=3000)
                    except:
                        box = None
                    
                    if box:
                        cx = box['x'] + box['width'] / 2
                        cy = box['y'] + box['height'] / 2
                        await cdp_click(cdp, cx, cy)
                        await asyncio.sleep(1.5)
                        now_paused = await v.evaluate('el => el.paused')
                        current = await v.evaluate('el => el.currentTime.toFixed(1)')
                        print(f'  ▶ clicked .ytp-large-play-button (paused={paused} → {now_paused}, t={current}s)')
                    else:
                        # Fallback: click center of video
                        box = await v.bounding_box()
                        if box:
                            cx = box['x'] + box['width'] / 2
                            cy = box['y'] + box['height'] / 2
                            await cdp_click(cdp, cx, cy)
                            await asyncio.sleep(1.5)
                            now_paused = await v.evaluate('el => el.paused')
                            current = await v.evaluate('el => el.currentTime.toFixed(1)')
                            print(f'  ▶ clicked video center (paused={paused} → {now_paused}, t={current}s)')
                else:
                    current = await v.evaluate('el => el.currentTime.toFixed(1)')
                    print(f'  ▶ already playing (t={current}s, autoplay)')
            except Exception as e:
                print(f'  ⚠️ video error: {e}')

            for _ in range(10):
                await asyncio.sleep(3)
                if any('SUCCEEDED' in e or 'FAILED' in e for e in events):
                    break

            success = any('SUCCEEDED' in e for e in events)
            if success:
                print(f'  🎉 CDP SKIP WORKS!\n')
                break
            elif any('FAILED' in e for e in events):
                print(f'  ❌ CDP FAILED')
            elif any('📺 Ad' in e for e in events):
                print(f'  📺 ad detected but no skip (bumper?)')
            else:
                print(f'  ⏭  no ad')
            
            # Show all extension events for diagnostics
            for e in events:
                print(f'    {e}')
            print()

            page.remove_listener('console', on_console)

        await browser.close()


if __name__ == '__main__':
    asyncio.run(main())
