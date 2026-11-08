import assert from "node:assert/strict";
import test from "node:test";
import { deriveStatus } from "../extension/status.js";

const blockedReason = "  Debugger unavailable — page still loading \n";
const cdp = (state, reason = null) => ({ state, reason, at: 1762500000000 });

test("disabled with cdp off is Paused", () => {
  assert.deepEqual(deriveStatus({ enabled: false, cdp: cdp("off") }), {
    state: "paused",
    word: "Paused",
    reason: null,
  });
});

test("disabled with cdp attached is Paused", () => {
  assert.deepEqual(deriveStatus({ enabled: false, cdp: cdp("attached") }), {
    state: "paused",
    word: "Paused",
    reason: null,
  });
});

test("disabled with cdp blocked is Paused without a reason", () => {
  assert.deepEqual(
    deriveStatus({ enabled: false, cdp: cdp("blocked", blockedReason) }),
    { state: "paused", word: "Paused", reason: null },
  );
});

test("enabled with cdp off is Active", () => {
  assert.deepEqual(deriveStatus({ enabled: true, cdp: cdp("off") }), {
    state: "active",
    word: "Active",
    reason: null,
  });
});

test("enabled with cdp attached is Active", () => {
  assert.deepEqual(deriveStatus({ enabled: true, cdp: cdp("attached") }), {
    state: "active",
    word: "Active",
    reason: null,
  });
});

test("blocked cdp stays Limited when enabling after Paused", () => {
  const blocked = cdp("blocked", blockedReason);
  assert.equal(deriveStatus({ enabled: false, cdp: blocked }).word, "Paused");
  assert.deepEqual(deriveStatus({ enabled: true, cdp: blocked }), {
    state: "limited",
    word: "Limited",
    reason: blockedReason,
  });
});

test("enabled with cdp blocked is Limited and copies its reason verbatim", () => {
  const result = deriveStatus({
    enabled: true,
    cdp: cdp("blocked", blockedReason),
  });
  assert.deepEqual(result, {
    state: "limited",
    word: "Limited",
    reason: blockedReason,
  });
  assert.equal(result.reason, blockedReason);
});
