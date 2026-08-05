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
    blocks: [],              // [{ el, originalHTML }]
    cache: new Map(),        // text-with-placeholders -> translated-with-placeholders
    lastSettings: null,      // remembered {bridgeUrl, token, target} for auto re-translate
    observer: null,          // MutationObserver
    reTranslateTimer: null,  // debounce timer
    inFlightRetranslate: false,
  };
  const state = window.__llmTranslateBridge;

  // Elements whose text should be translated as one unit.
  // NOTE: <A>, <BUTTON>, <LABEL> are NOT here — they're inline. Putting <A> here
  // was the root cause of v0.8-v0.12 losing <p>s that contained an inline <a>:
  // hasNestedBlockWithText saw the <a>, thought the <p> had a nested block, and
  // descended past the <p> — capturing only the link text and dropping the rest.
  const BLOCK_TAGS = new Set([
    "P","LI","DT","DD","BLOCKQUOTE",
    "H1","H2","H3","H4","H5","H6",
    "TD","TH","CAPTION","FIGCAPTION",
    "SUMMARY","LEGEND",
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
    "BR","IMG","BUTTON","LABEL","BDI","BDO","WBR","DFN","DEL","INS",
  ]);

  const PLACEHOLDER = (n) => `⟦${n}⟧`;
  const PLACEHOLDER_RE = /⟦(\d+)⟧/g;

  /**
   * Find translatable block elements. A block is captured if:
   *   - it's in BLOCK_TAGS, AND
   *   - it contains meaningful text, AND
   *   - it does NOT contain any nested block-tag descendant with text
   *     (nested-block case: we descend and capture the inner block instead)
   *
   * Non-block elements (e.g. <div>, <section>) are transparent — we recurse into
   * their children individually. This is the key fix vs v0.8: a <div> mixing a
   * <p> sibling with a <ul> sibling used to lose the <p> because the presence
   * of <ul> made us skip the whole <div>'s children iteration.
   */
  function findBlocks(root) {
    const blocks = [];

    function hasNestedBlockWithText(el) {
      for (const c of el.children) {
        if (SKIP_TAGS.has(c.tagName)) continue;
        if (BLOCK_TAGS.has(c.tagName) && c.textContent.trim().length >= 2) return true;
        if (hasNestedBlockWithText(c)) return true;
      }
      return false;
    }

    function visit(el) {
      if (!el) return;
      const tag = el.tagName;
      if (!tag || SKIP_TAGS.has(tag)) return;
      if (el.isContentEditable) return;

      if (BLOCK_TAGS.has(tag)) {
        // This IS a block. If it has nested blocks (e.g. <li> containing <p>),
        // prefer the inner blocks; otherwise capture this one.
        if (hasNestedBlockWithText(el)) {
          for (const c of el.children) visit(c);
          return;
        }
        const txt = el.textContent.trim();
        if (txt.length >= 2 && /\p{L}/u.test(txt)) blocks.push(el);
        return; // don't descend past a captured block
      }

      // Non-block container (<div>, <section>, <article>, <main>, ...):
      // ALWAYS descend into every child independently. This is what was broken
      // in v0.8 — sibling <p> got dropped when a <ul> sibling existed.
      for (const c of el.children) visit(c);
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
    // Remember settings so MutationObserver can auto re-translate on SPA nav.
    state.lastSettings = { bridgeUrl, token, target };

    // 1. Discover blocks. Save originalHTML for restore().
    // Exclude blocks we've already translated (state.blocks tracks by element).
    const alreadySeen = new WeakSet(state.blocks.map((b) => b.el));
    const found = findBlocks(document.body);
    const blocks = found.filter((el) => !alreadySeen.has(el));
    if (blocks.length === 0 && state.blocks.length > 0) {
      // Nothing new to translate.
      startObserver();
      return { ok: true, count: 0 };
    }
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
    // BATCH=30: 50 was the sweet spot for speed but Sonnet dropped ~20% of items on
    //           dense technical prose. 30 keeps parse discipline much higher.
    //           Bridge now bisects on partial parse, so even 30 is safe fallback.
    // CONCURRENCY=10: leaves headroom in the Max 5h window and dodges 429/529.
    const BATCH = 30;
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

    // Kick off the observer so newly-added blocks (SPA route change, lazy load,
    // Vue re-render) get translated too.
    startObserver();
    return { ok: true, count: applied };
  }

  /**
   * Watch the DOM for new translatable blocks and translate them automatically.
   * Debounced 800ms so bursts of mutations coalesce into one re-run.
   */
  function startObserver() {
    if (state.observer) return; // already watching
    state.observer = new MutationObserver(() => scheduleReTranslate());
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    });
    console.log("[llm-translate] MutationObserver armed");
  }

  function scheduleReTranslate() {
    if (!state.lastSettings) return;
    clearTimeout(state.reTranslateTimer);
    state.reTranslateTimer = setTimeout(runReTranslate, 800);
  }

  async function runReTranslate() {
    if (state.inFlightRetranslate) return; // don't overlap
    if (!state.lastSettings) return;
    state.inFlightRetranslate = true;
    try {
      const found = findBlocks(document.body);
      const alreadySeen = new WeakSet(state.blocks.map((b) => b.el));
      const fresh = found.filter((el) => !alreadySeen.has(el));
      if (fresh.length === 0) return;
      console.log(`[llm-translate] observer: ${fresh.length} new block(s) → re-translate`);
      // Re-enter doTranslate. It picks up only the new blocks via the same
      // alreadySeen filter, so no work is repeated.
      await doTranslate(state.lastSettings);
    } catch (e) {
      console.error("[llm-translate] observer re-translate failed:", e);
    } finally {
      state.inFlightRetranslate = false;
    }
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
        else if (msg.action === "diagnostic") sendResponse({ ok: true, diag: collectDiagnostic(msg) });
        else sendResponse({ ok: false, error: "unknown action" });
      } catch (e) {
        safeSend({ failed: { error: e.message } });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  });

  /**
   * Snapshot of the page's translation state — for the popup Diagnostic button
   * (so we don't need DevTools on sites with aggressive anti-debug).
   */
  function collectDiagnostic(msg) {
    // Re-run findBlocks so we see what WOULD be picked up right now,
    // even if the user hasn't hit Translate yet.
    let currentBlocks = [];
    try { currentBlocks = findBlocks(document.body); } catch {}

    // Any block that still contains a lot of ASCII letters and few CJK chars is
    // probably untranslated. Threshold: ≥30 latin chars and <3 CJK chars.
    const stillEnglish = [];
    for (const el of currentBlocks) {
      const txt = el.textContent.trim();
      if (txt.length < 40) continue;
      const latin = (txt.match(/[A-Za-z]/g) || []).length;
      const cjk = (txt.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
      if (latin >= 30 && cjk < 3) {
        stillEnglish.push({ tag: el.tagName, text: txt });
      }
    }

    // Try to locate the specific paragraph the user reported.
    // Walk the whole DOM and find the DEEPEST element whose textContent contains
    // the keyword — that's the actual paragraph, not <html> or <div id="app">.
    let targetInfo = "検索キーワード未指定";
    const keyword = (msg?.searchText || "Lateral Movement is a tactic").slice(0, 100);
    if (keyword) {
      const all = document.querySelectorAll("*");
      let deepest = null;
      let deepestDepth = -1;
      for (const el of all) {
        if (!el.textContent || !el.textContent.includes(keyword)) continue;
        // Skip elements that also have a child matching — we want the innermost.
        let hasChildMatch = false;
        for (const c of el.children) {
          if (c.textContent && c.textContent.includes(keyword)) { hasChildMatch = true; break; }
        }
        if (hasChildMatch) continue;
        // Compute depth from body
        let d = 0, cur = el;
        while (cur && cur !== document.body) { d++; cur = cur.parentElement; }
        if (d > deepestDepth) { deepestDepth = d; deepest = el; }
      }
      const hit = deepest;
      if (!hit) {
        targetInfo = `"${keyword}" を含む要素: 見つからず`;
      } else {
        const inBlocks = state.blocks.some((b) => b.el === hit);
        const inCurrentScan = currentBlocks.includes(hit);
        // Walk up to find the nearest BLOCK_TAG ancestor
        let blockAncestor = hit;
        while (blockAncestor && !BLOCK_TAGS.has(blockAncestor.tagName)) {
          blockAncestor = blockAncestor.parentElement;
        }
        const parentChain = [];
        let cur = hit;
        for (let i = 0; i < 8 && cur; i++) {
          const cls = cur.className && typeof cur.className === "string"
            ? "." + cur.className.split(/\s+/).slice(0, 3).join(".")
            : "";
          parentChain.push(`${cur.tagName}${cls}`);
          cur = cur.parentElement;
        }
        const hasSkipAncestor = (() => {
          let c = hit;
          while (c) { if (SKIP_TAGS.has(c.tagName)) return c.tagName; c = c.parentElement; }
          return null;
        })();
        targetInfo = [
          `キーワード: "${keyword}"`,
          `見つかった要素: <${hit.tagName}> (深さ${deepestDepth})`,
          `祖先チェーン (下から): ${parentChain.join(" > ")}`,
          `最寄りのBLOCK_TAG祖先: ${blockAncestor ? `<${blockAncestor.tagName}>` : "見つからず"}`,
          `SKIP_TAGS祖先: ${hasSkipAncestor || "なし"}`,
          `findBlocks で今この要素を拾えるか: ${inCurrentScan ? "YES" : "NO"}`,
          blockAncestor && blockAncestor !== hit ? `※ BLOCK祖先 <${blockAncestor.tagName}> が findBlocks で拾えるか: ${currentBlocks.includes(blockAncestor) ? "YES" : "NO"}` : "",
          `過去の翻訳実行で touched?: ${inBlocks ? "YES" : "NO"}`,
          ``,
          `outerHTML先頭400字:`,
          hit.outerHTML.slice(0, 400),
        ].filter(Boolean).join("\n");
      }
    }

    return {
      url: location.href,
      hasState: !!window.__llmTranslateBridge,
      blocksCount: state.blocks.length,
      cacheSize: state.cache.size,
      stillEnglish,
      targetInfo,
    };
  }
})();
