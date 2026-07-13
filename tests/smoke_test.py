#!/usr/bin/env python3
"""Smoke test: verify extension loads, content script injects, CDP pipeline ready."""
import asyncio, os, sys

EXT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'extension')
PROFILE_DIR = os.path.join(os.path.dirname(__file__), 'profiles', 'pw-test')

async def main():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            args=[
                f'--disable-extensions-except={EXT_PATH}',
                f'--load-extension={EXT_PATH}',
                '--no-sandbox', '--mute-audio',
            ],
            viewport={'width': 1280, 'height': 720},
        )
        page = await browser.new_page()

        msgs = []
        def on_console(msg):
            if 'AdSkip' in msg.text:
                msgs.append(msg.text)
        page.on('console', on_console)

        print('Loading YouTube...')
        await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', wait_until='domcontentloaded', timeout=15000)

        # Wait for extension to initialize and detect player
        await asyncio.sleep(3)

        print(f'\nAdSkip console messages ({len(msgs)}):')
        for m in msgs:
            print(f'  {m}')

        # Check key indicators
        has_loaded = any('content script loaded' in m for m in msgs)
        has_hooked = any('movie_player hooked' in m for m in msgs)
        has_started = any('startAll' in m for m in msgs)

        print(f'\nChecks:')
        print(f'  Content script loaded: {"PASS" if has_loaded else "FAIL"}')
        print(f'  movie_player hooked:   {"PASS" if has_hooked else "FAIL"}')
        print(f'  startAll called:       {"PASS" if has_started else "FAIL"}')

        # Test CDP directly via the background
        print('\nTesting CDP directly...')
        cdp = await page.context.new_cdp_session(page)
        try:
            await cdp.send('Input.dispatchMouseEvent', {
                'type': 'mouseMoved', 'x': 640, 'y': 360,
                'button': 'none', 'buttons': 0})
            print('  CDP mouseMoved: OK — CDP is available')
        except Exception as e:
            print(f'  CDP test FAILED: {e}')

        all_pass = has_loaded and has_hooked and has_started
        print(f'\n{"ALL CHECKS PASS" if all_pass else "SOME CHECKS FAILED"}')

        await browser.close()
        return 0 if all_pass else 1

if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
