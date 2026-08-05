// Service worker: relays progress events from content scripts to
//   (a) chrome.storage.session, so popup can restore state on reopen
//   (b) chrome.action badge, so the toolbar icon shows N/M live
//
// Payload shapes:
//   { progress: { current, total, tabId? } }   — a batch finished
//   { done:     { count, tabId? } }             — full translation done
//   { failed:   { error, tabId? } }             — hard error
//   { reset:    { tabId? } }                    — user hit "restore" / new run

chrome.runtime.onInstalled.addListener(() => {
  console.log("llm-translate-bridge extension installed");
});

const BADGE_COLORS = {
  progress: "#2563eb", // blue
  done: "#16a34a",     // green
  failed: "#dc2626",   // red
};

async function setBadge(tabId, text, color) {
  const target = tabId ? { tabId } : {};
  try {
    await chrome.action.setBadgeText({ ...target, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ ...target, color });
  } catch (e) {
    // tab may be gone
  }
}

async function saveState(tabId, state) {
  const key = `state:${tabId ?? "global"}`;
  await chrome.storage.session.set({ [key]: { ...state, ts: Date.now() } });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = msg?.tabId ?? sender?.tab?.id;

  if (msg?.progress) {
    const { current, total } = msg.progress;
    setBadge(tabId, `${current}/${total}`, BADGE_COLORS.progress);
    saveState(tabId, { kind: "progress", current, total });
    return;
  }
  if (msg?.done) {
    const { count } = msg.done;
    setBadge(tabId, "✓", BADGE_COLORS.done);
    saveState(tabId, { kind: "done", count });
    // Auto-clear the badge after 8s so it doesn't linger forever
    setTimeout(() => setBadge(tabId, "", BADGE_COLORS.done), 8000);
    return;
  }
  if (msg?.failed) {
    setBadge(tabId, "!", BADGE_COLORS.failed);
    saveState(tabId, { kind: "failed", error: msg.failed.error });
    return;
  }
  if (msg?.reset) {
    setBadge(tabId, "", BADGE_COLORS.progress);
    saveState(tabId, { kind: "idle" });
    return;
  }
});

// Clean up badge when a tab is closed/navigated away
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`state:${tabId}`).catch(() => {});
});
