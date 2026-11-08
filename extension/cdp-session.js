export const DETACH_GRACE_MS = 1500;

const REASON_NO_TARGET = "Debugger unavailable — page still loading";
const REASON_UNAVAILABLE = "Debugger unavailable — close DevTools or disable other extensions, then try again";
const REASON_DETACHED = "Detached by the browser";
const REASON_OWNER_UNKNOWN = "Debugger remains attached — owner unknown";
const REASON_CLICK_FAILED = "Debugger unavailable — click could not be delivered";

export function createCdpSession({ adapter, timers, publish, now, graceMs = DETACH_GRACE_MS }) {
  const records = new Map();
  let enabled = true;
  let disableEpoch = 0;
  let lastPublished;

  function isCurrent(record) {
    return records.get(record.tabId) === record;
  }

  function publicValue() {
    const blocked = [...records.values()]
      .filter((record) => record.state === "blocked")
      .sort((a, b) => b.blockedAt - a.blockedAt || a.tabId - b.tabId)[0];
    if (blocked) return { state: "blocked", reason: blocked.reason };
    if ([...records.values()].some((record) => record.state === "attached" || record.state === "draining")) {
      return { state: "attached", reason: null };
    }
    return { state: "off", reason: null };
  }

  function writeAggregate(force = false, silent = false) {
    if (silent) return;
    const value = publicValue();
    if (!force && lastPublished && lastPublished.state === value.state && lastPublished.reason === value.reason) return;
    const publication = { ...value, at: now() };
    lastPublished = value;
    try {
      const result = publish(publication);
      if (result && typeof result.then === "function") result.catch(() => {});
    } catch {
      // Publication failures do not affect session state.
    }
  }

  function newRecord(tabId) {
    const record = {
      tabId,
      state: "off",
      inAd: false,
      attempted: false,
      reason: null,
      blockedAt: null,
      timer: null,
      expectDetach: false,
      releaseUnverified: false,
      queue: [],
      running: false,
    };
    records.set(tabId, record);
    return record;
  }

  function getRecord(tabId, create = false) {
    return records.get(tabId) ?? (create ? newRecord(tabId) : null);
  }

  function setState(record, state, reason = null, silent = false) {
    if (!isCurrent(record)) return;
    const previous = record.state;
    if (previous === "draining" && state !== "draining") clearTimer(record);
    if (previous !== "blocked" && state === "blocked") record.blockedAt = now();
    else if (previous === "blocked" && state !== "blocked") record.blockedAt = null;
    record.state = state;
    record.reason = state === "blocked" ? reason : null;
    writeAggregate(false, silent);
  }

  function clearTimer(record) {
    if (record.timer === null) return;
    const timer = record.timer;
    record.timer = null;
    try {
      timers.clear(timer);
    } catch {
      // A stale timer handle is already inert.
    }
  }

  function dropQueued(record) {
    for (const item of record.queue.splice(0)) item.resolve(item.fallback);
  }

  function pump(record) {
    if (record.running) return;
    record.running = true;
    void (async () => {
      while (record.queue.length) {
        const item = record.queue.shift();
        if (!isCurrent(record)) {
          item.resolve(item.fallback);
          continue;
        }
        try {
          item.resolve(await item.run());
        } catch (error) {
          item.reject(error);
        }
      }
    })().finally(() => {
      record.running = false;
      if (record.queue.length) pump(record);
    });
  }

  function enqueue(record, run, fallback, dropPending = false) {
    if (!isCurrent(record)) return Promise.resolve(fallback);
    if (dropPending) dropQueued(record);
    const result = new Promise((resolve, reject) => {
      record.queue.push({ run, resolve, reject, fallback });
    });
    pump(record);
    return result;
  }

  function forget(record, silent = false) {
    if (!isCurrent(record)) return;
    clearTimer(record);
    records.delete(record.tabId);
    writeAggregate(false, silent);
  }

  function attachReason(result) {
    return result.code === "NO_TARGET" ? REASON_NO_TARGET : REASON_UNAVAILABLE;
  }

  async function attachRecord(record, silent = false) {
    let result;
    try {
      result = await adapter.attach(record.tabId);
    } catch (error) {
      result = { ok: false, code: "OTHER", message: error?.message ?? "" };
    }
    if (!isCurrent(record)) return { ok: false, reason: "tab removed" };
    if (result?.ok) {
      record.expectDetach = false;
      record.releaseUnverified = false;
      setState(record, "attached", null, silent);
      return { ok: true };
    }
    const reason = attachReason(result ?? { code: "OTHER" });
    setState(record, "blocked", reason, silent);
    return { ok: false, reason };
  }

  async function detachAndVerify(record, silent = false) {
    record.expectDetach = true;
    try {
      await adapter.detach(record.tabId);
    } catch {
      // The target read below is the release postcondition.
    }
    let pageTarget;
    try {
      pageTarget = await adapter.listPageTarget(record.tabId);
    } catch {
      if (isCurrent(record)) record.releaseUnverified = true;
      return;
    }
    if (!isCurrent(record)) return;
    record.releaseUnverified = false;
    if (pageTarget === null) {
      forget(record, silent);
    } else if (pageTarget?.attached === false) {
      setState(record, "off", null, silent);
    } else if (pageTarget?.attached === true) {
      setState(record, "blocked", REASON_OWNER_UNKNOWN, silent);
    } else {
      record.releaseUnverified = true;
    }
  }

  async function releaseAtDocumentBoundary(record) {
    if (!isCurrent(record)) return;
    record.inAd = false;
    record.attempted = false;
    clearTimer(record);
    if (record.state === "off" && !record.releaseUnverified) {
      setState(record, "off");
      return;
    }
    let pageTarget;
    try {
      pageTarget = await adapter.listPageTarget(record.tabId);
    } catch {
      return;
    }
    if (!isCurrent(record)) return;
    if (pageTarget === null) {
      record.releaseUnverified = false;
      forget(record);
      return;
    }
    if (pageTarget?.attached === false) {
      record.releaseUnverified = false;
      setState(record, "off");
      return;
    }
    if (pageTarget?.attached !== true) return;
    record.expectDetach = true;
    await detachAndVerify(record);
  }

  function startGrace(record) {
    let timerId;
    timerId = timers.set(() => {
      if (!isCurrent(record) || record.timer !== timerId) return;
      enqueue(record, async () => {
        if (!isCurrent(record) || record.state !== "draining" || record.timer !== timerId) return;
        record.timer = null;
        await detachAndVerify(record);
      }, undefined);
    }, graceMs);
    record.timer = timerId;
  }

  async function dispatch(record, x, y) {
    const epochAtDispatchStart = disableEpoch;
    const shouldAbort = () => !enabled || disableEpoch !== epochAtDispatchStart;
    let result;
    try {
      result = await adapter.dispatchClick(record.tabId, x, y, shouldAbort);
    } catch (error) {
      result = { ok: false, message: error?.message ?? "" };
    }
    if (!isCurrent(record)) return { ok: false, message: "tab removed" };
    if (shouldAbort() || result?.message === "disabled") {
      record.expectDetach = true;
      return { ok: false, message: "disabled" };
    }
    if (result?.ok) return { ok: true };
    setState(record, "blocked", REASON_CLICK_FAILED);
    return { ok: false, message: result?.message ?? "" };
  }

  async function clickRecord(record, x, y) {
    if (!enabled) return { ok: false, message: "disabled" };
    if (record.state === "attaching") return { ok: false, message: "unavailable" };
    if (record.state !== "attached" && record.state !== "draining") {
      record.attempted = true;
      setState(record, "attaching");
      const attached = await attachRecord(record);
      if (!attached.ok) return { ok: false, message: attached.reason };
    }
    if (!enabled) {
      record.expectDetach = true;
      return { ok: false, message: "disabled" };
    }
    return dispatch(record, x, y);
  }

  async function adStateRecord(record, inAd) {
    if (!isCurrent(record)) return;
    if (inAd && !enabled) return;
    record.inAd = inAd;
    if (!inAd) record.attempted = false;

    switch (record.state) {
      case "off":
        if (inAd && !record.attempted) {
          record.attempted = true;
          setState(record, "attaching");
          await attachRecord(record);
        }
        break;
      case "attaching":
        if (!inAd) {
          record.attempted = false;
          setState(record, "off");
        }
        break;
      case "attached":
        if (!inAd) {
          setState(record, "draining");
          startGrace(record);
        }
        break;
      case "draining":
        if (inAd) {
          clearTimer(record);
          record.attempted = true;
          setState(record, "attached");
        }
        break;
      case "blocked":
        if (!inAd) {
          await detachAndVerify(record);
        }
        break;
    }
  }

  async function disableRecord(record, silent) {
    if (!isCurrent(record)) return;
    record.attempted = false;
    clearTimer(record);
    if (record.state === "off" && !record.releaseUnverified) {
      writeAggregate(false, silent);
      return;
    }
    await detachAndVerify(record, silent);
  }

  async function documentBoundary(tabId) {
    const record = getRecord(tabId);
    if (!record) return;
    return enqueue(record, () => releaseAtDocumentBoundary(record), undefined, true);
  }

  async function setEnabled(value, options = {}) {
    const next = Boolean(value);
    if (next) {
      enabled = true;
      return;
    }
    const transitioned = enabled;
    if (transitioned) {
      enabled = false;
      disableEpoch += 1;
    }
    const recordsToDisable = [...records.values()].filter((record) =>
      transitioned || (record.state === "off" && record.releaseUnverified),
    );
    if (recordsToDisable.length === 0) return;
    const silent = options.silent === true;
    const work = recordsToDisable.map((record) => enqueue(
      record,
      () => disableRecord(record, silent),
      undefined,
    ));
    await Promise.all(work);
  }

  async function reconcile() {
    let targets;
    try {
      targets = await adapter.listTargets();
    } catch {
      return;
    }
    const attachedTargets = targets.filter((target) =>
      target.attached && typeof target.url === "string" && target.url.startsWith("https://www.youtube.com/"),
    );
    await Promise.all(attachedTargets.map((target) => {
      const record = getRecord(target.tabId, true);
      return enqueue(record, async () => {
        if (!isCurrent(record)) return;
        record.attempted = false;
        clearTimer(record);
        await detachAndVerify(record);
      }, undefined);
    }));
  }

  async function handleDetach(tabId) {
    const record = getRecord(tabId);
    if (!record) return;
    return enqueue(record, () => {
      if (record.expectDetach) {
        record.expectDetach = false;
        record.releaseUnverified = false;
        record.attempted = false;
        clearTimer(record);
        setState(record, "off");
        return;
      }
      if (record.state === "off" || record.state === "blocked") return;
      clearTimer(record);
      setState(record, "blocked", REASON_DETACHED);
    }, undefined);
  }

  async function handleTabRemoved(tabId) {
    const record = getRecord(tabId);
    if (!record) {
      writeAggregate(false);
      return;
    }
    return enqueue(record, () => {
      if (!isCurrent(record)) return;
      clearTimer(record);
      records.delete(tabId);
      writeAggregate(false);
    }, undefined, true);
  }

  async function click(tabId, x, y) {
    if (!enabled) return { ok: false, message: "disabled" };
    const record = getRecord(tabId, true);
    return enqueue(record, () => clickRecord(record, x, y), { ok: false });
  }

  async function adState(tabId, payload) {
    const inAd = Boolean(payload?.inAd);
    if (inAd && !enabled) return;
    const record = getRecord(tabId, true);
    return enqueue(record, () => adStateRecord(record, inAd), undefined);
  }

  async function publishAggregate() {
    writeAggregate(true);
  }

  function status(tabId) {
    const record = getRecord(tabId);
    if (!record) return { state: "off", reason: null };
    const state = record.state === "attaching" ? "off" : record.state === "draining" ? "attached" : record.state;
    return { state, reason: state === "blocked" ? record.reason : null };
  }

  return {
    setEnabled,
    reconcile,
    documentBoundary,
    publishAggregate,
    adState,
    click,
    handleDetach,
    handleTabRemoved,
    status,
  };
}
