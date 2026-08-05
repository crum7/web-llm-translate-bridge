// content.js — collects visible text nodes, sends them to the bridge, replaces in place.
// Idempotent: repeated injection is safe (guarded by window.__llmTranslateBridge).

(() => {
  if (window.__llmTranslateBridge) {
    // Re-bind message listener if the script was re-injected (Chrome doesn't dedupe).
    return;
  }
  window.__llmTranslateBridge = { originals: new WeakMap(), touched: [] };
  const state = window.__llmTranslateBridge;

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "CODE",
    "PRE",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "SVG",
    "MATH",
    "IFRAME",
  ]);

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        // Skip pure whitespace / punctuation-only fragments
        if (text.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function translateBatch(texts, { bridgeUrl, token, target }) {
    const res = await fetch(`${bridgeUrl}/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": token,
      },
      body: JSON.stringify({ texts, target }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`bridge ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.translations;
  }

  async function doTranslate({ bridgeUrl, token, target }) {
    if (!token) throw new Error("token未設定。拡張のオプションで設定してください");
    const nodes = collectTextNodes(document.body);
    if (nodes.length === 0) return { ok: true, count: 0 };

    // Batch size: keep prompts under a few KB. 40 snippets per call is a decent default.
    const BATCH = 40;
    const batches = chunk(nodes, BATCH);
    let done = 0;
    let bi = 0;

    console.log(`[llm-translate] ${nodes.length} nodes → ${batches.length} batch(es)`);
    // initial progress (batch 0 / total, so the badge shows up immediately)
    safeSend({ progress: { current: 0, total: batches.length } });

    for (const batch of batches) {
      bi++;
      const texts = batch.map((n) => n.nodeValue);
      const t0 = performance.now();
      console.log(`[llm-translate] batch ${bi}/${batches.length} (${texts.length} snippets) → POST ${bridgeUrl}/translate`);
      safeSend({ progress: { current: bi, total: batches.length } });
      let translations;
      try {
        translations = await translateBatch(texts, { bridgeUrl, token, target });
      } catch (e) {
        console.error(`[llm-translate] batch ${bi} failed:`, e);
        continue;
      }
      console.log(`[llm-translate] batch ${bi} ok in ${Math.round(performance.now() - t0)}ms`);
      batch.forEach((node, i) => {
        const t = translations[i];
        if (typeof t !== "string") return;
        if (!state.originals.has(node)) state.originals.set(node, node.nodeValue);
        node.nodeValue = t;
        state.touched.push(node);
      });
      done += batch.length;
    }
    console.log(`[llm-translate] done: ${done}/${nodes.length}`);
    safeSend({ done: { count: done } });
    return { ok: true, count: done };
  }

  // fire-and-forget message to the service worker (never let it throw)
  function safeSend(payload) {
    try {
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch {}
  }

  function doRestore() {
    for (const node of state.touched) {
      const orig = state.originals.get(node);
      if (typeof orig === "string") node.nodeValue = orig;
    }
    state.touched = [];
    safeSend({ reset: {} });
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.action === "translate") {
          const r = await doTranslate(msg);
          sendResponse(r);
        } else if (msg.action === "restore") {
          sendResponse(doRestore());
        } else {
          sendResponse({ ok: false, error: "unknown action" });
        }
      } catch (e) {
        safeSend({ failed: { error: e.message } });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // keep the message channel open for async response
  });
})();
