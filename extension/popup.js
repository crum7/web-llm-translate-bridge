const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    // already injected — ignore
  }
}

async function send(action, payload) {
  const tab = await activeTab();
  await ensureContentScript(tab.id);
  const { target } = await chrome.storage.sync.get({ target: "ja" });
  const settings = await chrome.storage.sync.get({
    bridgeUrl: "http://127.0.0.1:17891",
    token: "",
  });
  return chrome.tabs.sendMessage(tab.id, {
    action,
    target: payload?.target || target,
    bridgeUrl: settings.bridgeUrl,
    token: settings.token,
    tabId: tab.id,
  });
}

function renderStatus(state) {
  if (!state || state.kind === "idle") {
    $("status").textContent = "";
    return;
  }
  if (state.kind === "progress") {
    const { current, total } = state;
    if (current === 0) $("status").textContent = `翻訳準備中… (${total} バッチ)`;
    else $("status").textContent = `翻訳中… ${current}/${total} バッチ`;
    return;
  }
  if (state.kind === "done") {
    $("status").textContent = `${state.count}件 翻訳完了`;
    return;
  }
  if (state.kind === "failed") {
    $("status").textContent = `エラー: ${state.error || "unknown"}`;
    return;
  }
}

// Restore state on popup open (survives popup close/reopen)
(async () => {
  const tab = await activeTab();
  const key = `state:${tab.id}`;
  const stored = await chrome.storage.session.get(key);
  renderStatus(stored[key]);
})();

// Live updates while popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.progress) renderStatus({ kind: "progress", ...msg.progress });
  else if (msg?.done) renderStatus({ kind: "done", ...msg.done });
  else if (msg?.failed) renderStatus({ kind: "failed", ...msg.failed });
  else if (msg?.reset) renderStatus({ kind: "idle" });
});

// Also poll storage while popup is open, since sendMessage from content scripts
// during a long batch can race with popup mount.
const pollId = setInterval(async () => {
  const tab = await activeTab();
  const key = `state:${tab.id}`;
  const stored = await chrome.storage.session.get(key);
  if (stored[key]) renderStatus(stored[key]);
}, 1000);
window.addEventListener("unload", () => clearInterval(pollId));

$("go").addEventListener("click", async () => {
  const target = $("target").value;
  await chrome.storage.sync.set({ target });
  renderStatus({ kind: "progress", current: 0, total: "?" });
  try {
    const res = await send("translate", { target });
    if (res?.ok) renderStatus({ kind: "done", count: res.count });
    else renderStatus({ kind: "failed", error: res?.error || "unknown" });
  } catch (e) {
    renderStatus({ kind: "failed", error: e.message });
  }
});

$("restore").addEventListener("click", async () => {
  renderStatus({ kind: "idle" });
  await send("restore");
});

// Diagnostic button: dump content-script state into the popup, no DevTools required.
$("diag").addEventListener("click", async () => {
  const out = $("diagOut");
  out.style.display = "block";
  out.textContent = "収集中…";
  try {
    const tab = await activeTab();
    await ensureContentScript(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { action: "diagnostic" });
    if (!res?.ok) {
      out.textContent = `診断失敗: ${res?.error || "no response"}`;
      return;
    }
    const d = res.diag;
    const lines = [
      `URL: ${d.url}`,
      `bridge state: ${d.hasState ? "OK" : "MISSING (content.js未注入)"}`,
      `blocks総数: ${d.blocksCount}`,
      `cache件数: ${d.cacheSize}`,
      ``,
      `--- 翻訳漏れチェック (英語のまま残ってるブロック) ---`,
      `原文英語のまま残: ${d.stillEnglish.length}件`,
      ``,
      ...d.stillEnglish.slice(0, 20).map((s, i) => `[${i}] <${s.tag}> ${s.text.slice(0, 100)}`),
      ``,
      `--- 対象パラグラフ検索 ---`,
      d.targetInfo,
    ];
    out.textContent = lines.join("\n");
  } catch (e) {
    out.textContent = `エラー: ${e.message}`;
  }
});

// Load last-used target
chrome.storage.sync.get({ target: "ja" }).then(({ target }) => {
  $("target").value = target;
});
