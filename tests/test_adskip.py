#!/usr/bin/env python3
"""Deterministic startup checks and best-effort real-ad test for YT AdSkip."""

import asyncio
import os
import time

from playwright.async_api import async_playwright

EXT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'extension')
PROFILE_DIR = os.path.join(os.path.dirname(__file__), 'profiles', 'pw-fresh')
VIDEOS = [
    'dQw4w9WgXcQ', '9bZkp7q19f0', 'kJQP7kiw5Fk', 'RgKAFK5djSk',
    'JGwWNGJdvx8', 'OPf0YbXqDm0', 'YQHsXMglC9A', 'fRh_vgS2dFE',
    'CevxZvSJLk8', 'HP-MbfHFUqs', 'kXYiU_JCYtU', 'RBumgq5yVrA',
    'hT_nvWreIhg', '0KSOMA3QBU0', 'nfWlot6h_JM', '2Vv-BfVoq4g',
]

AD_DETECT_TIMEOUT = 2
SKIP_WAIT_TIMEOUT = 30


async def cdp_click(cdp, x, y):
    """Real mouse click via CDP - isTrusted: true."""
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseMoved', 'x': x, 'y': y, 'button': 'none', 'buttons': 0})
    await asyncio.sleep(0.05)
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'buttons': 1, 'clickCount': 1})
    await asyncio.sleep(0.03)
    await cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'buttons': 0, 'clickCount': 1})


async def wait_for_service_worker(context, timeout=10):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for worker in context.service_workers:
            if worker.url.startswith('chrome-extension://') and worker.url.endswith('/background.js'):
                return worker
        await asyncio.sleep(0.05)
    raise AssertionError('extension service worker did not start')


async def install_observers(worker):
    await worker.evaluate('''() => {
        globalThis.__adskipMessages = [];
        globalThis.__adskipConsoleEvents = [];
        for (const method of ['log', 'info', 'warn', 'error']) {
            const original = console[method].bind(console);
            console[method] = (...args) => {
                globalThis.__adskipConsoleEvents.push({
                    at: performance.timeOrigin + performance.now(),
                    text: args.map(String).join(' ')
                });
                return original(...args);
            };
        }
        chrome.runtime.onMessage.addListener((message, sender) => {
            const encoded = typeof message === 'string' ? message : JSON.stringify(message);
            if (encoded.includes('adskip:adState')) {
                globalThis.__adskipMessages.push({
                    at: Date.now(),
                    fromTab: !!sender.tab,
                    message: encoded
                });
            }
        });
    }''')


async def read_messages(worker):
    return await worker.evaluate('''() => globalThis.__adskipMessages || []''')


async def read_storage(worker):
    return await worker.evaluate('''() => new Promise(resolve => {
        chrome.storage.local.get(null, resolve);
    })''')


async def wait_for_ad(page, timeout):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        has_ad = await page.evaluate('''() => {
            const player = document.getElementById('movie_player');
            if (!player) return false;
            if (typeof player.getAdState === 'function' && player.getAdState() !== -1) return true;
            return player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
        }''')
        if has_ad:
            return True
        await asyncio.sleep(0.25)
    return False


async def wait_for_cdp_order(worker, page_console_events, timeout):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        events = await worker.evaluate('''() => globalThis.__adskipConsoleEvents || []''')
        combined = events + [
            {'at': at, 'text': text} for at, text in page_console_events
        ]
        combined.sort(key=lambda event: event['at'])
        lowered = [event['text'].lower() for event in combined]
        attach = next((i for i, event in enumerate(lowered) if 'attach' in event and 'detach' not in event), None)
        click = next((i for i, event in enumerate(lowered) if 'click' in event), None)
        detach = next((i for i, event in enumerate(lowered) if 'detach' in event), None)
        if attach is not None and click is not None and detach is not None and attach < click < detach:
            return combined
        await asyncio.sleep(0.1)
    return None


async def run_deterministic(context, worker):
    page = await context.new_page()
    await page.goto('https://www.youtube.com/watch?v=' + VIDEOS[0],
                    wait_until='domcontentloaded', timeout=30000)
    loaded_at_ms = time.time() * 1000
    deadline = asyncio.get_running_loop().time() + 3
    ad_state_message = None
    while asyncio.get_running_loop().time() < deadline:
        messages = await read_messages(worker)
        if messages:
            ad_state_message = messages[0]
            break
        await asyncio.sleep(0.05)
    assert ad_state_message is not None, 'content script did not send adskip:adState within 3 seconds'
    assert ad_state_message['fromTab'], 'adskip:adState was not sent by a content script'
    assert ad_state_message['at'] <= loaded_at_ms + 3000, 'adskip:adState arrived more than 3 seconds after page load'

    storage_deadline = asyncio.get_running_loop().time() + 10
    storage = await read_storage(worker)
    while 'cdp' not in storage and asyncio.get_running_loop().time() < storage_deadline:
        await asyncio.sleep(0.1)
        storage = await read_storage(worker)
    assert 'cdp' in storage, 'chrome.storage.local did not gain a cdp key after hydration'
    return page


async def run_best_effort(page, context, worker):
    cdp = await context.new_cdp_session(page)
    page_console_events = []
    page.on('console', lambda message: page_console_events.append((time.time() * 1000, message.text))
            if 'adskip' in message.text.lower() else None)
    for video_id in VIDEOS:
        try:
            page_console_events.clear()
            await worker.evaluate('''() => { globalThis.__adskipConsoleEvents.length = 0; }''')
            await page.goto('https://www.youtube.com/watch?v=' + video_id,
                            wait_until='domcontentloaded', timeout=15000)
        except Exception:
            continue

        try:
            await asyncio.sleep(0.8)
            video = page.locator('#movie_player video').first
            if await video.evaluate('element => element.paused'):
                box = await page.locator('.ytp-large-play-button').first.bounding_box(timeout=2000)
                if box:
                    await cdp_click(cdp, box['x'] + box['width'] / 2,
                                    box['y'] + box['height'] / 2)
        except Exception:
            pass

        if not await wait_for_ad(page, AD_DETECT_TIMEOUT):
            continue

        events = await wait_for_cdp_order(worker, page_console_events, SKIP_WAIT_TIMEOUT)
        assert events is not None, 'real ad appeared but attach, click, detach were not logged in order'
        await cdp.detach()
        return

    await cdp.detach()
    print('SKIP: no ad served')


async def main():
    print(f'Extension: {EXT_PATH}')
    print(f'Profile:   {PROFILE_DIR}')

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            args=[
                f'--disable-extensions-except={EXT_PATH}',
                f'--load-extension={EXT_PATH}',
                '--no-sandbox', '--disable-gpu', '--mute-audio',
            ],
            viewport={'width': 1280, 'height': 720},
        )
        try:
            print('DETERMINISTIC')
            worker = await wait_for_service_worker(context)
            assert worker.url.startswith('chrome-extension://'), 'extension did not load'
            await install_observers(worker)

            page = await run_deterministic(context, worker)

            print('BEST-EFFORT')
            await run_best_effort(page, context, worker)
        finally:
            await context.close()


if __name__ == '__main__':
    asyncio.run(main())
