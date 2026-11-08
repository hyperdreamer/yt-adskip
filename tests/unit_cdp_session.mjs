import assert from "node:assert/strict";
import test from "node:test";
import { createCdpSession, DETACH_GRACE_MS } from "../extension/cdp-session.js";

const TAB = 41;
const YOUTUBE_URL = "https://www.youtube.com/watch?v=test";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function waitFor(predicate) {
  for (let i = 0; i < 30; i += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("condition did not become true");
}

function harness(options = {}) {
  let time = options.now ?? 1000;
  let nextTimerId = 1;
  const calls = [];
  const publications = [];
  const targets = new Map();
  const pageOverrides = new Map();
  const timersById = new Map();
  const attachPlans = [];
  const detachPlans = [];
  const timers = {
    set(fn, ms) {
      const id = nextTimerId++;
      timersById.set(id, { fn, ms, due: time + ms });
      calls.push({ type: "timer-set", id, ms });
      return id;
    },
    clear(id) {
      calls.push({ type: "timer-clear", id });
      timersById.delete(id);
    },
  };
  const adapter = {
    async listTargets() {
      calls.push({ type: "listTargets" });
      if (options.listTargetsError) throw options.listTargetsError;
      return [...targets.values()].map((target) => ({ ...target }));
    },
    async listPageTarget(tabId) {
      calls.push({ type: "listPageTarget", tabId });
      if (pageOverrides.has(tabId)) {
        const override = pageOverrides.get(tabId);
        if (override instanceof Error) throw override;
        return override == null ? null : { ...override };
      }
      const target = targets.get(tabId);
      return target ? { attached: target.attached } : null;
    },
    async attach(tabId) {
      calls.push({ type: "attach", tabId });
      const plan = attachPlans.shift();
      const result = plan ? await plan(tabId) : { ok: true };
      if (result.ok) {
        targets.set(tabId, {
          tabId,
          attached: true,
          url: targets.get(tabId)?.url ?? YOUTUBE_URL,
        });
      }
      return result;
    },
    async detach(tabId) {
      calls.push({ type: "detach", tabId });
      const plan = detachPlans.shift();
      const outcome = plan ? await plan(tabId) : { released: true };
      if (outcome.attachedAfter === false) {
        const target = targets.get(tabId);
        if (target) targets.set(tabId, { ...target, attached: false });
      } else if (outcome.attachedAfter === true) {
        const target = targets.get(tabId) ?? { tabId, url: YOUTUBE_URL };
        targets.set(tabId, { ...target, attached: true });
      } else if (outcome.released) {
        const target = targets.get(tabId);
        if (target) targets.set(tabId, { ...target, attached: false });
      }
      return { released: outcome.released };
    },
    async dispatchClick(tabId, x, y, shouldAbort) {
      calls.push({ type: "dispatch", tabId, x, y, shouldAbort });
      if (options.dispatchPlan) {
        return options.dispatchPlan({ tabId, x, y, shouldAbort });
      }
      return { ok: true };
    },
  };
  const session = createCdpSession({
    adapter,
    timers,
    publish: (value) => publications.push({ ...value }),
    now: () => time,
    graceMs: options.graceMs,
  });
  return {
    session,
    adapter,
    calls,
    publications,
    targets,
    timersById,
    attachPlans,
    detachPlans,
    pageOverrides,
    setNow(value) {
      time = value;
    },
    seedTarget(tabId, attached = true, url = YOUTUBE_URL) {
      targets.set(tabId, { tabId, attached, url });
    },
    async advance(ms) {
      time += ms;
      const due = [...timersById.entries()]
        .filter(([, timer]) => timer.due <= time)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
      for (const [id, timer] of due) {
        if (!timersById.has(id)) continue;
        timersById.delete(id);
        timer.fn();
      }
      await flush();
    },
  };
}

function countCalls(h, type, tabId) {
  return h.calls.filter((call) => call.type === type && (tabId == null || call.tabId === tabId)).length;
}

async function attach(h, tabId = TAB) {
  await h.session.adState(tabId, { inAd: true });
  assert.equal(h.session.status(tabId).state, "attached");
}

function queueAttachGate(h, gate) {
  h.attachPlans.push(() => gate.promise);
}

function queueDetachGate(h, gate, result = { released: true, attachedAfter: false }) {
  h.detachPlans.push(async () => {
    const release = await gate.promise;
    return release ?? result;
  });
}

test("T1.01 off + true makes exactly one attach", async () => {
  const h = harness();
  await h.session.adState(TAB, { inAd: true });
  assert.equal(countCalls(h, "attach", TAB), 1);
  assert.equal(h.session.status(TAB).state, "attached");
});

test("T1.02 repeated true while attached is a no-op", async () => {
  const h = harness();
  await attach(h);
  const before = h.calls.length;
  await h.session.adState(TAB, { inAd: true });
  assert.equal(h.calls.length, before);
});

test("T1.03 attached click dispatches without attach or detach", async () => {
  const h = harness();
  await attach(h);
  h.calls.length = 0;
  assert.deepEqual(await h.session.click(TAB, 12, 34), { ok: true });
  assert.equal(countCalls(h, "dispatch", TAB), 1);
  assert.equal(countCalls(h, "attach", TAB), 0);
  assert.equal(countCalls(h, "detach", TAB), 0);

  const failed = harness({
    dispatchPlan: async () => ({ ok: false, message: "raw adapter detail" }),
  });
  await attach(failed);
  assert.deepEqual(await failed.session.click(TAB, 1, 2), { ok: false, message: "raw adapter detail" });
  assert.deepEqual(failed.session.status(TAB), {
    state: "blocked",
    reason: "Debugger unavailable — click could not be delivered",
  });
});

test("T1.04 off click performs one attach then dispatch", async () => {
  const h = harness();
  assert.deepEqual(await h.session.click(TAB, 12, 34), { ok: true });
  assert.equal(countCalls(h, "attach", TAB), 1);
  assert.equal(countCalls(h, "dispatch", TAB), 1);
  assert.ok(h.calls.findIndex((call) => call.type === "attach") < h.calls.findIndex((call) => call.type === "dispatch"));
});

test("T1.05 a true heartbeat before grace retains the session", async () => {
  const h = harness();
  await attach(h);
  await h.session.adState(TAB, { inAd: false });
  await h.session.adState(TAB, { inAd: true });
  assert.equal(h.session.status(TAB).state, "attached");
  await h.session.adState(TAB, { inAd: false });
  await h.advance(DETACH_GRACE_MS);
  assert.equal(countCalls(h, "attach", TAB), 1);
  assert.equal(countCalls(h, "detach", TAB), 1);
});

test("T1.06 false followed by grace expiry detaches exactly once", async () => {
  const h = harness();
  await attach(h);
  await h.session.adState(TAB, { inAd: false });
  await h.advance(DETACH_GRACE_MS);
  assert.equal(countCalls(h, "detach", TAB), 1);
  assert.equal(countCalls(h, "listPageTarget", TAB), 1);
  assert.equal(h.session.status(TAB).state, "off");
});

test("T1.07 refusal blocks and repeated true does not retry autonomously", async () => {
  const h = harness();
  h.attachPlans.push(async () => ({ ok: false, code: "NO_TARGET", message: "raw" }));
  await h.session.adState(TAB, { inAd: true });
  await h.session.adState(TAB, { inAd: true });
  assert.equal(countCalls(h, "attach", TAB), 1);
  assert.equal(h.session.status(TAB).state, "blocked");
  assert.equal(h.session.status(TAB).reason, "Debugger unavailable — page still loading");

  const general = harness();
  general.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
  await general.session.adState(TAB, { inAd: true });
  assert.equal(general.session.status(TAB).reason, "Debugger unavailable — close DevTools or disable other extensions, then try again");
});

test("T1.08 unexpected detach while attached becomes blocked", async () => {
  const h = harness();
  await attach(h);
  await h.session.handleDetach(TAB);
  assert.deepEqual(h.session.status(TAB), { state: "blocked", reason: "Detached by the browser" });
});

test("T1.09 disable clears grace timer and verifies immediate detach", async () => {
  const h = harness();
  await attach(h);
  await h.session.adState(TAB, { inAd: false });
  assert.equal(h.timersById.size, 1);
  await h.session.setEnabled(false);
  assert.equal(h.timersById.size, 0);
  assert.equal(countCalls(h, "detach", TAB), 1);
  assert.equal(countCalls(h, "listPageTarget", TAB), 1);
  assert.equal(h.session.status(TAB).state, "off");
});

test("T1.10 tab removal forgets the record without detach and republishes", async () => {
  const h = harness();
  await attach(h);
  const publicationsBefore = h.publications.length;
  await h.session.handleTabRemoved(TAB);
  assert.deepEqual(h.session.status(TAB), { state: "off", reason: null });
  assert.equal(countCalls(h, "detach", TAB), 0);
  assert.ok(h.publications.length > publicationsBefore);
  assert.equal(h.publications.at(-1).state, "off");
});

test("T1.11 blocked outranks attached and equal blockedAt uses the lowest tab id", async () => {
  const h = harness();
  h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
  await h.session.adState(8, { inAd: true });
  await attach(h, 9);
  assert.equal(h.publications.at(-1).state, "blocked");
  await h.session.adState(8, { inAd: false });
  assert.equal(h.publications.at(-1).state, "attached");

  const tied = harness({ now: 77 });
  tied.attachPlans.push(
    async () => ({ ok: false, code: "OTHER", message: "raw" }),
    async () => ({ ok: false, code: "NO_TARGET", message: "raw" }),
  );
  await tied.session.adState(12, { inAd: true });
  await tied.session.adState(3, { inAd: true });
  assert.equal(tied.publications.at(-1).reason, "Debugger unavailable — page still loading");
});

test("T1.12 disable queued during attach waits, then detaches and verifies", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const ad = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const disabling = h.session.setEnabled(false);
  gate.resolve({ ok: true });
  await Promise.all([ad, disabling]);
  assert.equal(countCalls(h, "detach", TAB), 1);
  assert.equal(countCalls(h, "listPageTarget", TAB), 1);
  assert.equal(h.session.status(TAB).state, "off");
});

test("T1.13 false during attach drains after attach settles", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const ad = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const ended = h.session.adState(TAB, { inAd: false });
  gate.resolve({ ok: true });
  await Promise.all([ad, ended]);
  assert.equal(h.session.status(TAB).state, "attached");
  await h.advance(DETACH_GRACE_MS);
  assert.equal(countCalls(h, "detach", TAB), 1);
  assert.equal(h.session.status(TAB).state, "off");
});

test("T1.14 removing during attach never detaches the removed tab", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const ad = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const removal = h.session.handleTabRemoved(TAB);
  gate.resolve({ ok: true });
  await Promise.all([ad, removal]);
  assert.equal(countCalls(h, "detach", TAB), 0);
  assert.deepEqual(h.session.status(TAB), { state: "off", reason: null });
});

test("T1.15 blocked false verifies release, clears reason, and ends off", async () => {
  const h = harness();
  h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
  await h.session.adState(TAB, { inAd: true });
  h.seedTarget(TAB, true);
  await h.session.adState(TAB, { inAd: false });
  assert.deepEqual(h.session.status(TAB), { state: "off", reason: null });
  assert.equal(countCalls(h, "detach", TAB), 1);
  assert.equal(countCalls(h, "listPageTarget", TAB), 1);
});

test("T1.16 false queued during attach drains without early release or reattach", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const ad = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const ended = h.session.adState(TAB, { inAd: false });
  gate.resolve({ ok: true });
  await Promise.all([ad, ended]);
  assert.equal(countCalls(h, "attach", TAB), 1);
  assert.equal(countCalls(h, "detach", TAB), 0);
  assert.equal(h.session.status(TAB).state, "attached");
  assert.equal(h.timersById.size, 1);
});

test("T1.17 expected onDetach after grace release remains off", async () => {
  const h = harness();
  await attach(h);
  await h.session.adState(TAB, { inAd: false });
  await h.advance(DETACH_GRACE_MS);
  await h.session.handleDetach(TAB);
  assert.equal(h.session.status(TAB).state, "off");
  assert.equal(h.session.status(TAB).reason, null);
});

test("document boundary retries release after an unverified off record", async () => {
  const h = harness();
  h.seedTarget(TAB, true);
  const listPageTarget = h.adapter.listPageTarget;
  let pageReads = 0;
  h.adapter.listPageTarget = async (tabId) => {
    pageReads += 1;
    if (pageReads === 1) throw new Error("target read failed");
    return listPageTarget(tabId);
  };
  h.detachPlans.push(async () => ({ released: true, attachedAfter: true }));

  await h.session.reconcile();
  assert.equal(h.session.status(TAB).state, "off");
  assert.equal(h.targets.get(TAB).attached, true);

  await h.session.documentBoundary(TAB);
  assert.equal(h.targets.get(TAB).attached, false);
  assert.equal(countCalls(h, "detach", TAB), 2);
  assert.equal(pageReads, 3);
});

test("disable retries release after an unverified off record", async () => {
  const h = harness();
  h.seedTarget(TAB, true);
  const listPageTarget = h.adapter.listPageTarget;
  let pageReads = 0;
  h.adapter.listPageTarget = async (tabId) => {
    pageReads += 1;
    if (pageReads === 1) throw new Error("target read failed");
    return listPageTarget(tabId);
  };
  h.detachPlans.push(async () => ({ released: true, attachedAfter: true }));

  await h.session.reconcile();
  await h.session.setEnabled(false);

  assert.equal(h.targets.get(TAB).attached, false);
  assert.equal(countCalls(h, "detach", TAB), 2);
  assert.equal(pageReads, 2);
});

test("T1.18 reconcile releases a pre-existing attachment without probing", async () => {
  const h = harness();
  h.seedTarget(TAB, true);
  await h.session.reconcile();
  assert.equal(countCalls(h, "detach", TAB), 1);
  assert.equal(countCalls(h, "dispatch", TAB), 0);
  assert.equal(countCalls(h, "listPageTarget", TAB), 1);
  assert.equal(h.session.status(TAB).state, "off");
});

test("T1.19 reconcile blocks neutrally when a pre-existing target stays attached", async () => {
  const h = harness();
  h.seedTarget(TAB, true);
  h.detachPlans.push(async () => ({ released: false, attachedAfter: true }));
  await h.session.reconcile();
  assert.deepEqual(h.session.status(TAB), {
    state: "blocked",
    reason: "Debugger remains attached — owner unknown",
  });
});

test("T1.20 false then true queued during attach rolls draining back to attached", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const ad = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const ended = h.session.adState(TAB, { inAd: false });
  const resumed = h.session.adState(TAB, { inAd: true });
  gate.resolve({ ok: true });
  await Promise.all([ad, ended, resumed]);
  assert.equal(countCalls(h, "attach", TAB), 1);
  assert.equal(countCalls(h, "detach", TAB), 0);
  assert.equal(h.timersById.size, 0);
  assert.equal(h.session.status(TAB).state, "attached");
});

test("T1.21 click queued during attach dispatches after exactly one attach", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const ad = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const click = h.session.click(TAB, 20, 30);
  gate.resolve({ ok: true });
  await Promise.all([ad, click]);
  assert.equal(countCalls(h, "attach", TAB), 1);
  assert.equal(countCalls(h, "dispatch", TAB), 1);
});

test("T1.22 reconcile releases the restarted session and heartbeat re-establishes it", async () => {
  const previous = harness();
  await attach(previous);
  const restarted = harness();
  restarted.seedTarget(TAB, true);
  await restarted.session.reconcile();
  assert.equal(restarted.session.status(TAB).state, "off");
  assert.equal(countCalls(restarted, "detach", TAB), 1);
  await restarted.session.adState(TAB, { inAd: true });
  const attachCount = countCalls(restarted, "attach", TAB);
  await restarted.session.adState(TAB, { inAd: true });
  assert.equal(attachCount, 1);
  assert.equal(countCalls(restarted, "attach", TAB), 1);
});

test("T1.23 hydration publication clears stale aggregate unconditionally", async () => {
  const h = harness();
  await h.session.reconcile();
  await h.session.publishAggregate();
  const count = h.publications.length;
  await h.session.publishAggregate();
  assert.equal(h.publications.length, count + 1);
  assert.deepEqual(h.publications.at(-1).state, "off");
  assert.equal(h.publications.at(-1).reason, null);
});

test("T1.24 queued click rechecks disabled before dispatch", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const ad = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const click = h.session.click(TAB, 20, 30);
  const disabling = h.session.setEnabled(false);
  gate.resolve({ ok: true });
  const result = await click;
  await Promise.all([ad, disabling]);
  assert.deepEqual(result, { ok: false, message: "disabled" });
  assert.equal(countCalls(h, "dispatch", TAB), 0);
});

test("T1.25 disabled true is ignored while false is accepted", async () => {
  const h = harness();
  h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
  await h.session.adState(TAB, { inAd: true });
  await h.session.setEnabled(false);
  const before = countCalls(h, "attach", TAB);
  await h.session.adState(TAB, { inAd: true });
  assert.equal(countCalls(h, "attach", TAB), before);
  await h.session.adState(TAB, { inAd: false });
  assert.equal(h.session.status(TAB).state, "off");
  assert.equal(h.session.status(TAB).reason, null);
});

test("T1.26 reconcile leaves non-YouTube targets untouched and untracked", async () => {
  const h = harness();
  h.seedTarget(TAB, true, "https://example.com/");
  await h.session.reconcile();
  assert.equal(countCalls(h, "detach", TAB), 0);
  assert.deepEqual(h.session.status(TAB), { state: "off", reason: null });
  assert.equal(h.publications.at(-1)?.state ?? "off", "off");
});

test("T1.27 disable then re-enable clears attempted for the next ad", async () => {
  const h = harness();
  await attach(h);
  await h.session.setEnabled(false);
  await h.session.setEnabled(true);
  await h.session.adState(TAB, { inAd: true });
  assert.equal(countCalls(h, "attach", TAB), 2);
  assert.equal(h.session.status(TAB).state, "attached");
});

test("T1.28 disable aborts dispatch and queues verified teardown", async () => {
  const moved = deferred();
  const release = deferred();
  const events = [];
  const h = harness({
    dispatchPlan: async ({ shouldAbort }) => {
      events.push("mouseMoved");
      moved.resolve();
      await release.promise;
      if (shouldAbort()) return { ok: false, message: "disabled" };
      events.push("mousePressed");
      events.push("mouseReleased");
      return { ok: true };
    },
  });
  await attach(h);
  const click = h.session.click(TAB, 5, 6);
  await moved.promise;
  const disabling = h.session.setEnabled(false);
  release.resolve();
  assert.deepEqual(await click, { ok: false, message: "disabled" });
  await disabling;
  assert.deepEqual(events, ["mouseMoved"]);
  assert.equal(countCalls(h, "detach", TAB), 1);
  assert.equal(countCalls(h, "listPageTarget", TAB), 1);
});

test("T1.29 unreleased detach stays blocked in grace, disable, and reconcile", async () => {
  async function verify(path) {
    const h = harness();
    if (path === "reconcile") {
      h.seedTarget(TAB, true);
    } else {
      await attach(h);
      h.detachPlans.push(async () => ({ released: false, attachedAfter: true }));
    }
    if (path === "grace") {
      await h.session.adState(TAB, { inAd: false });
      await h.advance(DETACH_GRACE_MS);
    } else if (path === "disable") {
      await h.session.setEnabled(false);
    } else {
      h.detachPlans.push(async () => ({ released: false, attachedAfter: true }));
      await h.session.reconcile();
    }
    assert.equal(h.session.status(TAB).state, "blocked", path);
    assert.equal(h.session.status(TAB).reason, "Debugger remains attached — owner unknown", path);
  }
  await verify("grace");
  await verify("disable");
  await verify("reconcile");
});

test("T1.30 true queued during grace detach attaches after confirmed off", async () => {
  const h = harness();
  await attach(h);
  const gate = deferred();
  queueDetachGate(h, gate);
  await h.session.adState(TAB, { inAd: false });
  const advance = h.advance(DETACH_GRACE_MS);
  await waitFor(() => countCalls(h, "detach", TAB) === 1);
  const resumed = h.session.adState(TAB, { inAd: true });
  gate.resolve({ released: true, attachedAfter: false });
  await Promise.all([advance, resumed]);
  assert.equal(countCalls(h, "attach", TAB), 2);
  assert.equal(h.session.status(TAB).state, "attached");
});

test("T1.31 every state-changing route to off clears attempted behaviorally", async () => {
  const routes = [
    ["attaching false", async (h) => {
      const gate = deferred();
      queueAttachGate(h, gate);
      const pending = h.session.adState(TAB, { inAd: true });
      await waitFor(() => countCalls(h, "attach", TAB) === 1);
      const ended = h.session.adState(TAB, { inAd: false });
      gate.resolve({ ok: false, code: "OTHER", message: "refused" });
      await Promise.all([pending, ended]);
    }],
    ["attaching disable", async (h) => {
      const gate = deferred();
      queueAttachGate(h, gate);
      const pending = h.session.adState(TAB, { inAd: true });
      await waitFor(() => countCalls(h, "attach", TAB) === 1);
      const disabling = h.session.setEnabled(false);
      gate.resolve({ ok: true });
      await Promise.all([pending, disabling]);
      await h.session.setEnabled(true);
    }],
    ["attaching document boundary", async (h) => {
      const gate = deferred();
      queueAttachGate(h, gate);
      const pending = h.session.adState(TAB, { inAd: true });
      await waitFor(() => countCalls(h, "attach", TAB) === 1);
      const boundary = h.session.documentBoundary(TAB);
      gate.resolve({ ok: true });
      await Promise.all([pending, boundary]);
    }],
    ["attached disable", async (h) => {
      await attach(h);
      await h.session.setEnabled(false);
      await h.session.setEnabled(true);
    }],
    ["attached document boundary", async (h) => {
      await attach(h);
      await h.session.documentBoundary(TAB);
    }],
    ["draining grace", async (h) => {
      await attach(h);
      await h.session.adState(TAB, { inAd: false });
      await h.advance(DETACH_GRACE_MS);
    }],
    ["draining disable", async (h) => {
      await attach(h);
      await h.session.adState(TAB, { inAd: false });
      await h.session.setEnabled(false);
      await h.session.setEnabled(true);
    }],
    ["draining document boundary", async (h) => {
      await attach(h);
      await h.session.adState(TAB, { inAd: false });
      await h.session.documentBoundary(TAB);
    }],
    ["blocked false", async (h) => {
      h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
      await h.session.adState(TAB, { inAd: true });
      await h.session.adState(TAB, { inAd: false });
    }],
    ["blocked disable", async (h) => {
      h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
      await h.session.adState(TAB, { inAd: true });
      await h.session.setEnabled(false);
      await h.session.setEnabled(true);
    }],
    ["blocked document boundary", async (h) => {
      h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
      await h.session.adState(TAB, { inAd: true });
      await h.session.documentBoundary(TAB);
    }],
  ];
  for (const [name, reachOff] of routes) {
    const h = harness();
    await reachOff(h);
    assert.equal(h.session.status(TAB).state, "off", name);
    const before = countCalls(h, "attach", TAB);
    await h.session.adState(TAB, { inAd: true });
    assert.equal(countCalls(h, "attach", TAB), before + 1, name);
  }
});

test("T1.32 document boundary after refusal allows a fresh ad attach", async () => {
  const h = harness();
  h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
  await h.session.adState(TAB, { inAd: true });
  await h.session.documentBoundary(TAB);
  await h.session.adState(TAB, { inAd: true });
  assert.equal(countCalls(h, "attach", TAB), 2);
  assert.equal(h.session.status(TAB).state, "attached");
});

test("T1.33 external detach while attaching blocks without adoption", async () => {
  const h = harness();
  const gate = deferred();
  queueAttachGate(h, gate);
  const pending = h.session.adState(TAB, { inAd: true });
  await waitFor(() => countCalls(h, "attach", TAB) === 1);
  const detached = h.session.handleDetach(TAB);
  gate.resolve({ ok: true });
  await Promise.all([pending, detached]);
  assert.equal(h.session.status(TAB).state, "blocked");
  assert.equal(h.session.status(TAB).reason, "Detached by the browser");
});

test("T1.34 missing tab or null page target at boundary never detaches", async () => {
  for (const mode of ["missing", "null"]) {
    const h = harness();
    await attach(h);
    if (mode === "missing") h.targets.delete(TAB);
    else h.pageOverrides.set(TAB, null);
    await h.session.documentBoundary(TAB);
    assert.equal(countCalls(h, "detach", TAB), 0, mode);
    assert.equal(h.session.status(TAB).state, "off", mode);
  }
});

test("T1.35 blocked false, disable, and boundary publish off only after release", async () => {
  for (const path of ["false", "disable", "boundary"]) {
    const h = harness();
    h.attachPlans.push(async () => ({ ok: false, code: "OTHER", message: "raw" }));
    await h.session.adState(TAB, { inAd: true });
    h.seedTarget(TAB, true);
    const gate = deferred();
    queueDetachGate(h, gate);
    let operation;
    if (path === "false") operation = h.session.adState(TAB, { inAd: false });
    else if (path === "disable") operation = h.session.setEnabled(false);
    else operation = h.session.documentBoundary(TAB);
    await waitFor(() => countCalls(h, "detach", TAB) === 1);
    assert.equal(h.publications.at(-1).state, "blocked", path);
    gate.resolve({ released: true, attachedAfter: false });
    await operation;
    assert.equal(h.session.status(TAB).state, "off", path);
    assert.equal(h.session.status(TAB).reason, null, path);
    const lastPublication = h.publications.at(-1);
    assert.deepEqual(
      lastPublication && { state: lastPublication.state, reason: lastPublication.reason },
      { state: "off", reason: null },
      path,
    );
    assert.equal(countCalls(h, "listPageTarget", TAB), path === "boundary" ? 2 : 1, path);
  }
});

test("T1.36 disable then re-enable between mouse events still aborts the third", async () => {
  const pressed = deferred();
  const release = deferred();
  const events = [];
  const h = harness({
    dispatchPlan: async ({ shouldAbort }) => {
      events.push("mouseMoved");
      if (shouldAbort()) return { ok: false, message: "disabled" };
      events.push("mousePressed");
      pressed.resolve();
      await release.promise;
      if (shouldAbort()) return { ok: false, message: "disabled" };
      events.push("mouseReleased");
      return { ok: true };
    },
  });
  await attach(h);
  const click = h.session.click(TAB, 10, 11);
  await pressed.promise;
  const disabling = h.session.setEnabled(false);
  const enabling = h.session.setEnabled(true);
  release.resolve();
  assert.deepEqual(await click, { ok: false, message: "disabled" });
  await Promise.all([disabling, enabling]);
  assert.deepEqual(events, ["mouseMoved", "mousePressed"]);
});
