export function deriveStatus({ enabled, cdp }) {
  if (!enabled) {
    return { state: "paused", word: "Paused", reason: null };
  }

  if (cdp.state === "blocked") {
    return { state: "limited", word: "Limited", reason: cdp.reason };
  }

  return { state: "active", word: "Active", reason: null };
}
