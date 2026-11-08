import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { test } from "node:test";

let moduleSequence = 0;

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    dispatch(...args) {
      for (const listener of listeners) listener(...args);
    },
    listeners,
  };
}

function makeChrome({
  storageReadFailures = 0,
  attachError = null,
  sendMessageError = null,
  queryError = null,
  initiallyAttached = false,
} = {}) {
  const target = {
    type: "page",
    tabId: 7,
    attached: initiallyAttached,
    url: "https://www.youtube.com/watch?v=test",
  };
  const state = {
    storageGetCalls: 0,
    storageSetCalls: [],
    detachCallsAtStorageWrite: [],
    targetReads: 0,
    attachCalls: 0,
    detachCalls: 0,
    commands: [],
    queries: [],
    sentMessages: [],
  };
  const events = {
    onMessage: createEvent(),
    onChanged: createEvent(),
    onDetach: createEvent(),
    onUpdated: createEvent(),
    onRemoved: createEvent(),
  };
  const runtime = { lastError: undefined };

  function invokeCallback(callback, error, ...args) {
    runtime.lastError = error ? { message: error } : undefined;
    try {
      callback(...args);
    } finally {
      runtime.lastError = undefined;
    }
  }

  const chrome = {
    runtime: {
      ...runtime,
      get lastError() {
        return runtime.lastError;
      },
      set lastError(value) {
        runtime.lastError = value;
      },
      onMessage: events.onMessage,
    },
    storage: {
      onChanged: events.onChanged,
      local: {
        get(defaults) {
          state.storageGetCalls += 1;
          if (state.storageGetCalls <= storageReadFailures) {
            return Promise.reject(new Error("storage read failed"));
          }
          return Promise.resolve({ ...defaults });
        },
        set(value) {
          state.storageSetCalls.push(structuredClone(value));
          state.detachCallsAtStorageWrite.push(state.detachCalls);
          return Promise.resolve();
        },
      },
    },
    debugger: {
      onDetach: events.onDetach,
      getTargets(callback) {
        state.targetReads += 1;
        invokeCallback(callback, null, [{ ...target }]);
      },
      attach(_debuggee, _version, callback) {
        state.attachCalls += 1;
        if (!attachError) target.attached = true;
        invokeCallback(callback, attachError);
      },
      detach(_debuggee, callback) {
        state.detachCalls += 1;
        target.attached = false;
        invokeCallback(callback, null);
      },
      sendCommand(_debuggee, method, params, callback) {
        state.commands.push({ method, params });
        invokeCallback(callback, null, {});
      },
    },
    tabs: {
      onUpdated: events.onUpdated,
      onRemoved: events.onRemoved,
      query(query) {
        state.queries.push(query);
        if (queryError) return Promise.reject(queryError);
        return Promise.resolve([{ id: target.tabId }]);
      },
      sendMessage(tabId, message) {
        state.sentMessages.push({ tabId, message });
        if (sendMessageError) return Promise.reject(sendMessageError);
        return Promise.resolve();
      },
    },
  };

  return { chrome, events, state, target };
}

async function loadWorker(options) {
  const harness = makeChrome(options);
  globalThis.chrome = harness.chrome;
  const url = new URL(`../extension/background.js?case=${++moduleSequence}`, import.meta.url);
  const worker = await import(url.href);
  await worker.readyPromise;
  return { ...harness, worker };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message ?? "condition was not reached");
}

test("storage read rejection retries three times, fails closed, and publishes once after reconciliation", async () => {
  const { events, state } = await loadWorker({
    storageReadFailures: 3,
    initiallyAttached: true,
  });

  assert.equal(state.storageGetCalls, 3);
  assert.equal(state.targetReads, 2);
  assert.equal(state.detachCalls, 1);
  assert.deepEqual(state.detachCallsAtStorageWrite, [1]);
  assert.equal(state.storageSetCalls.length, 1);
  assert.deepEqual(state.storageSetCalls[0], {
    cdp: { state: "off", reason: null, at: state.storageSetCalls[0].cdp.at },
  });

  let response;
  const keepChannelOpen = events.onMessage.listeners[0](
    { type: "adskip:click", x: 30, y: 40 },
    { tab: { id: 7 } },
    (value) => { response = value; },
  );
  assert.equal(keepChannelOpen, true);
  await waitFor(() => response !== undefined, "disabled click was not answered");
  assert.deepEqual(response, { ok: false, message: "disabled" });
  assert.equal(state.storageSetCalls.length, 1);
});

test("adskip:click returns true synchronously and responds asynchronously", async () => {
  const { events, state } = await loadWorker();
  let response;
  const returned = events.onMessage.listeners[0](
    { type: "adskip:click", x: 30, y: 40 },
    { tab: { id: 7 } },
    (value) => { response = value; },
  );

  assert.equal(returned, true);
  assert.equal(response, undefined);
  await waitFor(() => response !== undefined, "click response was not sent");
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(state.commands.map(({ params }) => params.type), [
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);
});

test("only loading tab updates call documentBoundary", async () => {
  const { events, state, target } = await loadWorker();
  const listener = events.onMessage.listeners[0];
  assert.equal(listener(
    { type: "adskip:adState", inAd: true },
    { tab: { id: 7 } },
    () => assert.fail("adState must not respond"),
  ), false);
  await waitFor(() => target.attached, "adState did not attach the page target");

  const tab = { get url() { throw new Error("onUpdated must not read tab.url"); } };
  events.onUpdated.dispatch(7, { status: "complete" }, tab);
  await waitImmediate();
  assert.equal(state.detachCalls, 0);

  events.onUpdated.dispatch(7, { status: "loading" }, tab);
  await waitFor(() => state.detachCalls === 1, "loading update did not release the target");
  assert.equal(target.attached, false);
});

test("attach lastError is normalized to UNAVAILABLE and preserves its message", async () => {
  const message = "Another debugger is already attached to the tab";
  const { worker } = await loadWorker({ attachError: message });

  assert.deepEqual(await worker.adapter.attach(7), {
    ok: false,
    code: "UNAVAILABLE",
    message,
  });
});

test("hello ignores a missing content-script receiver", async () => {
  const unhandled = [];
  const captureUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", captureUnhandled);
  try {
    const { state } = await loadWorker({
      sendMessageError: new Error("Could not establish connection. Receiving end does not exist."),
    });
    await waitFor(() => state.sentMessages.length === 1, "hello was not sent");
    await waitImmediate();
    assert.deepEqual(state.sentMessages, [{ tabId: 7, message: { type: "adskip:hello" } }]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", captureUnhandled);
  }
});
