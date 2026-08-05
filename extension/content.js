// content.js — block-level in-place translation with placeholder-preserved inline markup.
//
// Design principle: LLM only does the actual translation work. Everything mechanical
// (finding blocks, freezing inline tags into placeholders, deduping, restoring, DOM
// swap) is handled by deterministic code.
//
// Pipeline per block:
//   1. Freeze inline children (<code>, <a>, <strong>, ...) into ⟦N⟧ placeholders,
//      keep the original nodes in a per-block slot map.
//   2. Send the flattened text (with placeholders) to the bridge for translation.
//   3. Restore placeholders in the translated string by putting the original inline
//      nodes back into a new fragment, then swap the block's innerHTML.

(() => {
  if (window.__llmTranslateBridge) return;
  window.__llmTranslateBridge = {
    blocks: [],           // [{ el, originalHTML }]
    cache: new Map(),     // text-with-placeholders -> translated-with-placeholders
  };
  const state = window.__llmTranslateBridge;

  // Elements whose text should be translated as one unit.
  const BLOCK_TAGS = new Set([
    "P","LI","DT","DD","BLOCKQUOTE",
    "H1","H2","H3","H4","H5","H6",
    "TD","TH","CAPTION","FIGCAPTION",
    "SUMMARY","LEGEND","LABEL","BUTTON","A",
  ]);

  // Elements to skip entirely (never traverse into).
  const SKIP_TAGS = new Set([
    "SCRIPT","STYLE","NOSCRIPT","CODE","PRE","KBD","SAMP",
    "TEXTAREA","INPUT","SELECT","OPTION","SVG","MATH","IFRAME","OBJECT","VIDEO","AUDIO",
  ]);

  // Inline elements that appear inside blocks — they get frozen into placeholders.
  const INLINE_TAGS = new Set([
    "A","STRONG","B","EM","I","U","S","MARK","SMALL","SUB","SUP",
    "CODE","KBD","SAMP","SPAN","ABBR","CITE","Q","TIME","VAR",
    "BR","IMG","BUTTON","LABEL",
  ]);

  const PLACEHOLDER = (n) => `⟦${n}⟧`;
  const PLACEHOLDER_RE = /⟦(\d+)⟧/g;

  /**
   * Find translatable block elements: those that contain visible text and are not
   * ancestors of other block elements we already picked (avoid double-translating).
   */
  function findBlocks(root) {
    const blocks = [];
    const seen = new WeakSet();

    function visit(el) {
      if (!el || seen.has(el)) return;
      const tag = el.tagName;
      if (!tag || SKIP_TAGS.has(tag)) return;
      if (el.isContentEditable) return;

      // Does this element contain child block elements? If so, recurse into them
      // instead of treating this as one block.
      const childBlocks = Array.from(el.children).filter((c) => BLOCK_TAGS.has(c.tagName) || containsBlock(c));
      if (childBlocks.length > 0) {
        for (const c of el.children) visit(c);
        return;
      }

      // Otherwise, if THIS is a block and has meaningful text, capture it.
      if (BLOCK_TAGS.has(tag)) {
        const txt = el.textContent.trim();
        if (txt.length >= 2 && /\p{L}/u.test(txt)) {
          blocks.push(el);
          seen.add(el);
        }
        return;
      }

      // Not a block itself — recurse.
      for (const c of el.children) visit(c);
    }

    function containsBlock(el) {
      if (BLOCK_TAGS.has(el.tagName)) return true;
      for (const c of el.children) if (containsBlock(c)) return true;
      return false;
    }

    visit(root);
    return blocks;
  }

  /**
   * Convert a block element into { text, slots } where inline elements are replaced
   * with ⟦N⟧ placeholders. slots[N] holds the original HTML string for restoration.
   */
  function freezeBlock(el) {
    const slots = [];
    let out = "";

    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Any inline element — freeze it into a placeholder, keep its outerHTML for restore.
        // Also treat unknown elements this way (safer than descending).
        const tag = node.tagName;
        if (SKIP_TAGS.has(tag)) {
          // e.g. <script> inside a paragraph — keep as-is (opaque)
          const idx = slots.push(node.outerHTML) - 1;
          out += PLACEHOLDER(idx);
        } else if (INLINE_TAGS.has(tag) || !BLOCK_TAGS.has(tag)) {
          const idx = slots.push(node.outerHTML) - 1;
          out += PLACEHOLDER(idx);
        } else {
          // Shouldn't happen after findBlocks(), but be defensive.
          out += node.textContent;
        }
      }
    }

    return { text: out.replace(/\s+/g, " ").trim(), slots };
  }

  /**
   * Restore placeholders in a translated string back into the block's DOM.
   * Handles the case where the LLM dropped or duplicated a placeholder.
   */
  function applyTranslation(el, translated, slots, originalText) {
    // If translation is empty or unchanged, no-op.
    if (!translated || translated === originalText) return false;

    let html = escapeHtml(translated);
    // Un-escape ⟦N⟧ back (⟦ and ⟧ pass through escapeHtml, but we build via textContent
    // above so nothing to undo — just replace placeholders with slot HTML).
    html = html.replace(PLACEHOLDER_RE, (_, n) => {
      const idx = Number(n);
      return slots[idx] ?? "";
    });

    el.innerHTML = html;
    return true;
  }

  function escapeHtml(s) {
    // Escape everything EXCEPT our placeholder brackets ⟦ ⟧ (which aren't HTML special).
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function translateBatch(texts, { bridgeUrl, token, target }, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    try {
      const res = await fetch(`${bridgeUrl}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bridge-token": token },
        body: JSON.stringify({ texts, target }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const retriable = res.status >= 500 && res.status < 600;
        if (retriable && attempt < MAX_ATTEMPTS) {
          console.warn(`[llm-translate] retry ${attempt}/${MAX_ATTEMPTS} after ${res.status}`);
          await sleep(1000 * attempt);
          return translateBatch(texts, { bridgeUrl, token, target }, attempt + 1);
        }
        throw new Error(`bridge ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return data.translations;
    } catch (e) {
      const netFail = e instanceof TypeError || /fetch|network|ECONN/i.test(e.message);
      if (netFail && attempt < MAX_ATTEMPTS) {
        console.warn(`[llm-translate] network retry ${attempt}/${MAX_ATTEMPTS}: ${e.message}`);
        await sleep(1500 * attempt);
        return translateBatch(texts, { bridgeUrl, token, target }, attempt + 1);
      }
      throw e;
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function doTranslate({ bridgeUrl, token, target }) {
    if (!token) throw new Error("token未設定。拡張のオプションで設定してください");

    // 1. Discover blocks. Save originalHTML for restore().
    const blocks = findBlocks(document.body);
    if (blocks.length === 0) return { ok: true, count: 0 };
    for (const el of blocks) state.blocks.push({ el, originalHTML: el.innerHTML });

    // 2. Freeze inline markup into placeholders. Build the unique-string queue.
    const frozen = blocks.map((el) => ({ el, ...freezeBlock(el) }));
    const uniqueTexts = [];
    const textIndex = new Map(); // text -> index in uniqueTexts
    for (const f of frozen) {
      if (!f.text) continue;
      if (state.cache.has(f.text)) continue; // already translated in a previous run
      if (textIndex.has(f.text)) continue;
      textIndex.set(f.text, uniqueTexts.length);
      uniqueTexts.push(f.text);
    }

    console.log(
      `[llm-translate] ${blocks.length} blocks, ${uniqueTexts.length} unique strings ` +
      `(dedup saved ${frozen.length - uniqueTexts.length - state.cache.size})`,
    );

    // 3. Batch + parallel translate the unique strings.
    const BATCH = 50;
    const CONCURRENCY = 10;
    const batches = chunk(uniqueTexts, BATCH);
    let completed = 0;
    safeSend({ progress: { current: 0, total: batches.length } });

    const queue = batches.map((b, i) => ({ batch: b, idx: i + 1 }));
    async function worker(wid) {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) break;
        const { batch, idx } = job;
        const t0 = performance.now();
        console.log(`[llm-translate] [w${wid}] batch ${idx}/${batches.length} (${batch.length})`);
        let translations;
        try {
          translations = await translateBatch(batch, { bridgeUrl, token, target });
        } catch (e) {
          console.error(`[llm-translate] [w${wid}] batch ${idx} failed:`, e);
          completed++;
          safeSend({ progress: { current: completed, total: batches.length } });
          continue;
        }
        // Fill cache with results
        batch.forEach((src, i) => {
          const tr = translations[i];
          if (typeof tr === "string") state.cache.set(src, tr);
        });
        completed++;
        console.log(`[llm-translate] [w${wid}] batch ${idx} ok in ${Math.round(performance.now() - t0)}ms`);
        safeSend({ progress: { current: completed, total: batches.length } });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

    // 4. Apply translations back to DOM, restoring placeholders.
    let applied = 0;
    for (const f of frozen) {
      if (!f.text) continue;
      const tr = state.cache.get(f.text);
      if (!tr) continue;
      if (applyTranslation(f.el, tr, f.slots, f.text)) applied++;
    }

    console.log(`[llm-translate] applied ${applied}/${blocks.length} blocks`);
    safeSend({ done: { count: applied } });
    return { ok: true, count: applied };
  }

  function doRestore() {
    for (const b of state.blocks) {
      try { b.el.innerHTML = b.originalHTML; } catch {}
    }
    state.blocks = [];
    safeSend({ reset: {} });
    return { ok: true };
  }

  function safeSend(payload) {
    try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch {}
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.action === "translate") sendResponse(await doTranslate(msg));
        else if (msg.action === "restore") sendResponse(doRestore());
        else sendResponse({ ok: false, error: "unknown action" });
      } catch (e) {
        safeSend({ failed: { error: e.message } });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  });
})();
