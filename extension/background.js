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

// Image proxy: content scripts hit CORS on cross-origin images, but the
// extension itself (via host_permissions <all_urls>) can fetch anything.
// Handler returns a data: URL so content.js can inline the image into Markdown.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action !== "fetchImageAsDataUrl") return; // not for us
  (async () => {
    try {
      const res = await fetch(msg.url, { credentials: "include" });
      if (!res.ok) return sendResponse({ ok: false, error: `HTTP ${res.status}` });
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onloadend = () => sendResponse({ ok: true, dataUrl: reader.result });
      reader.onerror = () => sendResponse({ ok: false, error: String(reader.error) });
      reader.readAsDataURL(blob);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});
