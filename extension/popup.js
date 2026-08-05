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
  });
}

$("go").addEventListener("click", async () => {
  const target = $("target").value;
  await chrome.storage.sync.set({ target });
  $("status").textContent = "翻訳中…";
  try {
    const res = await send("translate", { target });
    $("status").textContent = res?.ok
      ? `${res.count}件 翻訳完了`
      : `エラー: ${res?.error || "unknown"}`;
  } catch (e) {
    $("status").textContent = `エラー: ${e.message}`;
  }
});

$("restore").addEventListener("click", async () => {
  $("status").textContent = "";
  await send("restore");
});

// Load last-used target
chrome.storage.sync.get({ target: "ja" }).then(({ target }) => {
  $("target").value = target;
});
