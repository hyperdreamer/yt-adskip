import { createCdpSession, DETACH_GRACE_MS } from "./cdp-session.js";

const LOG_PREFIX = "[YT AdSkip BG]";
const chromeApi = chrome;
const HELLO_MESSAGE = { type: "adskip:hello" };
const YOUTUBE_URL_PATTERN = "https://www.youtube.com/*";
let aggregateFailureLogged = false;
let hydrationComplete = false;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logAggregateFailure(error) {
  if (aggregateFailureLogged) return;
  aggregateFailureLogged = true;
  console.warn(LOG_PREFIX, "aggregate storage write failed:", error?.message ?? error);
}

function lastError() {
  const error = chromeApi.runtime.lastError;
  return error ? new Error(error.message || "Chrome API call failed") : null;
}

function getTargets() {
  return new Promise((resolve, reject) => {
    try {
      chromeApi.debugger.getTargets((targets) => {
        const error = lastError();
        if (error) {
          log("debugger target read failed:", error.message);
          reject(error);
        } else if (!Array.isArray(targets)) {
          const invalidResult = new Error("Debugger returned an invalid target list");
          log("debugger target read failed:", invalidResult.message);
          reject(invalidResult);
        } else {
          resolve(targets);
        }
      });
    } catch (error) {
      log("debugger target read failed:", error?.message ?? error);
      reject(error);
    }
  });
}

function attachCode(message) {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("no target") ||
    normalized.includes("no tab with") ||
    normalized.includes("tab was closed") ||
    normalized.includes("tab not found")
  ) {
    return "NO_TARGET";
  }
  if (
    normalized.includes("debugger") ||
    normalized.includes("devtools") ||
    normalized.includes("cannot access") ||
    normalized.includes("cannot attach")
  ) {
    return "UNAVAILABLE";
  }
  return "OTHER";
}

function sendMouseEvent(tabId, event) {
  return new Promise((resolve, reject) => {
    try {
      chromeApi.debugger.sendCommand(
        { tabId },
        "Input.dispatchMouseEvent",
        event,
        (result) => {
          const error = lastError();
          if (error) reject(error);
          else resolve(result);
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

export const adapter = {
  async listTargets() {
    const targets = await getTargets();
    return targets
      .filter((target) => target.type === "page")
      .map((target) => ({
        tabId: target.tabId,
        attached: Boolean(target.attached),
        url: typeof target.url === "string" ? target.url : "",
      }));
  },

  async listPageTarget(tabId) {
    const targets = await getTargets();
    const target = targets.find((candidate) =>
      candidate.type === "page" && candidate.tabId === tabId,
    );
    return target ? { attached: Boolean(target.attached) } : null;
  },

  attach(tabId) {
    return new Promise((resolve) => {
      const finish = (error) => {
        if (!error) {
          resolve({ ok: true });
          return;
        }
        log("debugger attach refused:", error.message);
        resolve({
          ok: false,
          code: attachCode(error.message),
          message: error.message,
        });
      };
      try {
        chromeApi.debugger.attach({ tabId }, "1.3", () => finish(lastError()));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  },

  detach(tabId) {
    return new Promise((resolve) => {
      try {
        chromeApi.debugger.detach({ tabId }, () => {
          resolve({ released: lastError() === null });
        });
      } catch {
        resolve({ released: false });
      }
    });
  },

  async dispatchClick(tabId, x, y, shouldAbort) {
    const events = [
      {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
        clickCount: 0,
      },
      {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
    ];
    const pauses = [15, 30];

    for (let index = 0; index < events.length; index += 1) {
      if (shouldAbort()) return { ok: false, message: "disabled" };
      try {
        await sendMouseEvent(tabId, events[index]);
      } catch (error) {
        const message = error?.message ?? String(error);
        log("CDP click failed:", message);
        return { ok: false, message };
      }
      if (index < pauses.length) {
        if (shouldAbort()) return { ok: false, message: "disabled" };
        await new Promise((resolve) => setTimeout(resolve, pauses[index]));
        if (shouldAbort()) return { ok: false, message: "disabled" };
      }
    }

    return { ok: true };
  },
};

function publish(cdp) {
  if (!hydrationComplete) return undefined;
  try {
    const result = chromeApi.storage.local.set({ cdp });
    if (result && typeof result.then === "function") {
      return result.then(
        () => { aggregateFailureLogged = false; },
        logAggregateFailure,
      );
    }
    return undefined;
  } catch (error) {
    logAggregateFailure(error);
    return undefined;
  }
}

const session = createCdpSession({
  adapter,
  timers: {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => clearTimeout(id),
  },
  publish,
  now: () => Date.now(),
  graceMs: DETACH_GRACE_MS,
});

function validTabId(sender) {
  return Number.isInteger(sender?.tab?.id) && sender.tab.id >= 0;
}

function invalidMessage() {
  console.warn(LOG_PREFIX, "dropped invalid runtime message");
}

function handleMessage(message, sender, sendResponse) {
  if (!message || typeof message !== "object") return false;
  if (message.type !== "adskip:adState" && message.type !== "adskip:click") return false;

  const tabId = validTabId(sender) ? sender.tab.id : null;
  const validPayload = message.type === "adskip:adState"
    ? typeof message.inAd === "boolean"
    : Number.isFinite(message.x) && Number.isFinite(message.y);
  if (tabId === null || !validPayload) {
    invalidMessage();
    return false;
  }

  if (message.type === "adskip:adState") {
    void (async () => {
      await readyPromise;
      await session.adState(tabId, { inAd: message.inAd });
    })().catch((error) => log("adState handling failed:", error?.message ?? error));
    return false;
  }

  void (async () => {
    await readyPromise;
    const result = await session.click(tabId, message.x, message.y);
    const response = { ok: Boolean(result?.ok) };
    if (result?.message !== undefined) response.message = result.message;
    sendResponse(response);
  })().catch((error) => {
    try {
      sendResponse({ ok: false, message: error?.message ?? String(error) });
    } catch {
      // The response channel may already be closed.
    }
  });
  return true;
}

let readyPromise;

chromeApi.runtime.onMessage.addListener(handleMessage);
chromeApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes || !Object.hasOwn(changes, "enabled")) return;
  void (async () => {
    await readyPromise;
    await session.setEnabled(changes.enabled?.newValue !== false);
  })().catch((error) => log("enabled change handling failed:", error?.message ?? error));
});
chromeApi.debugger.onDetach.addListener((source) => {
  if (!Number.isInteger(source?.tabId)) return;
  void (async () => {
    await readyPromise;
    await session.handleDetach(source.tabId);
  })().catch((error) => log("debugger detach handling failed:", error?.message ?? error));
});
chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.status !== "loading") return;
  void (async () => {
    await readyPromise;
    await session.documentBoundary(tabId);
  })().catch((error) => log("document boundary handling failed:", error?.message ?? error));
});
chromeApi.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await readyPromise;
    await session.handleTabRemoved(tabId);
  })().catch((error) => log("tab removal handling failed:", error?.message ?? error));
});

async function hydrateSession() {
  let stored;
  let readSucceeded = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      stored = await chromeApi.storage.local.get({ enabled: true });
      readSucceeded = true;
      break;
    } catch (error) {
      if (attempt === 2) {
        log("enabled hydration failed after three reads; failing closed:", error?.message ?? error);
      }
    }
  }

  const enabled = readSucceeded
    ? (stored && Object.hasOwn(stored, "enabled") ? stored.enabled !== false : true)
    : false;
  await session.setEnabled(enabled, { silent: true });
  try {
    await session.reconcile();
  } catch (error) {
    log("target reconciliation failed:", error?.message ?? error);
  }
  hydrationComplete = true;
  await session.publishAggregate();
}

async function broadcastHello() {
  let tabs;
  try {
    tabs = await chromeApi.tabs.query({ url: YOUTUBE_URL_PATTERN });
  } catch (error) {
    log("hello tab query failed:", error?.message ?? error);
    return;
  }

  await Promise.all((Array.isArray(tabs) ? tabs : []).map(async (tab) => {
    if (!Number.isInteger(tab?.id)) return;
    try {
      await chromeApi.tabs.sendMessage(tab.id, HELLO_MESSAGE);
    } catch (error) {
      const message = error?.message ?? String(error);
      if (message.includes("Receiving end does not exist")) return;
      log("hello delivery failed:", message);
    }
  }));
}

readyPromise = hydrateSession();
void readyPromise.then(() => {
  void broadcastHello();
});

export { readyPromise };
