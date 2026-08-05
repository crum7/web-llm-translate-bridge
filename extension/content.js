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

  // Persistent cache config
  const CACHE_KEY = "__llmTranslateBridge_cache_v1";
  const CACHE_MAX_ENTRIES = 20000;     // ~ a few MB at 100 chars avg
  const CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
  const CACHE_FLUSH_DEBOUNCE_MS = 1500;

  // Cache is stored per-target-language so "same text, different target" doesn't collide.
  // localStorage layout: { "en->ja": { "source text ⟦0⟧": {t:"訳文 ⟦0⟧", ts:169..} , ... } }
  function loadCacheFromStorage() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch { return {}; }
  }
  const persistedBuckets = loadCacheFromStorage();

  window.__llmTranslateBridge = {
    blocks: [],              // [{ el, originalHTML }]
    cache: new Map(),        // text-with-placeholders -> translated-with-placeholders (in-memory, hot)
    persistedBuckets,        // { "en->ja": { text: {t, ts}, ... } }
    persistBucketKey: null,  // set when first target lang known
    persistDirty: false,
    persistTimer: null,
    lastSettings: null,      // remembered {bridgeUrl, token, target} for auto re-translate
    observer: null,          // MutationObserver
    reTranslateTimer: null,  // debounce timer
    inFlightRetranslate: false,
    lastUrl: null,           // SPA route-change detection
  };
  const state = window.__llmTranslateBridge;

  function bucketKeyFor(target, source = "auto") {
    return `${source}->${target}`;
  }

  function seedCacheFromPersisted(target, source = "auto") {
    const key = bucketKeyFor(target, source);
    state.persistBucketKey = key;
    const bucket = state.persistedBuckets[key] || {};
    const now = Date.now();
    let loaded = 0;
    let expired = 0;
    for (const [src, rec] of Object.entries(bucket)) {
      if (!rec || typeof rec.t !== "string") continue;
      if (rec.ts && now - rec.ts > CACHE_TTL_MS) {
        delete bucket[src];
        expired++;
        continue;
      }
      state.cache.set(src, rec.t);
      loaded++;
    }
    if (expired > 0) schedulePersistFlush();
    console.log(`[llm-translate] cache loaded: ${loaded} entries from ${key} (expired: ${expired})`);
    return loaded;
  }

  function persistPut(src, translated) {
    if (!state.persistBucketKey) return;
    const bucket = (state.persistedBuckets[state.persistBucketKey] ||= {});
    bucket[src] = { t: translated, ts: Date.now() };
    state.persistDirty = true;
    schedulePersistFlush();
  }

  function schedulePersistFlush() {
    if (state.persistTimer) return;
    state.persistTimer = setTimeout(flushPersist, CACHE_FLUSH_DEBOUNCE_MS);
  }

  function flushPersist() {
    state.persistTimer = null;
    if (!state.persistDirty) return;
    // Enforce global entry cap across all buckets — evict oldest by ts.
    try {
      let totalEntries = 0;
      for (const b of Object.values(state.persistedBuckets)) totalEntries += Object.keys(b).length;
      if (totalEntries > CACHE_MAX_ENTRIES) {
        // Flatten, sort by ts asc, drop the oldest excess.
        const flat = [];
        for (const [bk, b] of Object.entries(state.persistedBuckets)) {
          for (const [src, rec] of Object.entries(b)) flat.push({ bk, src, ts: rec.ts || 0 });
        }
        flat.sort((a, b) => a.ts - b.ts);
        const toDrop = flat.slice(0, totalEntries - CACHE_MAX_ENTRIES);
        for (const d of toDrop) delete state.persistedBuckets[d.bk][d.src];
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(state.persistedBuckets));
      state.persistDirty = false;
    } catch (e) {
      // QuotaExceeded — drop half the entries and retry once.
      console.warn("[llm-translate] persist failed, pruning:", e.message);
      try {
        for (const [bk, b] of Object.entries(state.persistedBuckets)) {
          const entries = Object.entries(b).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
          const keep = entries.slice(Math.floor(entries.length / 2));
          state.persistedBuckets[bk] = Object.fromEntries(keep);
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(state.persistedBuckets));
        state.persistDirty = false;
      } catch (e2) {
        console.error("[llm-translate] persist really failed:", e2.message);
      }
    }
  }

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
   * Find translatable block elements. Simple full-DOM walk:
   *   1. Skip subtrees rooted at SKIP_TAGS.
   *   2. For every element that IS a BLOCK_TAG:
   *      - If it has any BLOCK_TAG descendant with real text, skip capturing
   *        THIS one (we'll capture the inner block(s) instead). Still descend.
   *      - Otherwise, if it has real text of its own, capture it.
   *   3. Always descend into children of non-SKIP elements.
   *
   * This replaces v0.10..v0.12's early-return logic which was silently
   * losing <p> nodes on certain DOM shapes (confirmed via popup diagnostic
   * showing a valid <p> at depth 17 that findBlocks couldn't find).
   */
  function findBlocks(root) {
    const blocks = [];
    const captured = new WeakSet();

    // Pre-pass: mark all BLOCK ancestors of any captured text-holder so we
    // don't double-capture. Actually simpler: do it inline via hasNestedBlock.
    function hasBlockDescendantWithText(el) {
      // BFS one level at a time (not recursive) — cheaper on huge trees.
      const stack = Array.from(el.children);
      while (stack.length) {
        const c = stack.pop();
        if (!c || !c.tagName) continue;
        if (SKIP_TAGS.has(c.tagName)) continue;
        if (BLOCK_TAGS.has(c.tagName)) {
          const t = c.textContent && c.textContent.trim();
          if (t && t.length >= 2 && /\p{L}/u.test(t)) return true;
        }
        for (const cc of c.children) stack.push(cc);
      }
      return false;
    }

    function walk(el) {
      if (!el || !el.tagName) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.isContentEditable) return;

      if (BLOCK_TAGS.has(el.tagName)) {
        const txt = el.textContent ? el.textContent.trim() : "";
        const hasLetters = /\p{L}/u.test(txt);
        // Only skip THIS block if it wraps other blocks (e.g. <li> containing <p>).
        // Otherwise capture it — even if children include inline stuff.
        if (!hasBlockDescendantWithText(el)) {
          if (hasLetters && txt.length >= 2 && !captured.has(el)) {
            blocks.push(el);
            captured.add(el);
          }
          return; // no need to descend — this block has no inner blocks
        }
        // wraps other blocks — descend, don't capture self
      }

      for (const c of el.children) walk(c);
    }

    walk(root);
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

  async function translateBatch(texts, { bridgeUrl, token, target, model }, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    try {
      const res = await fetch(`${bridgeUrl}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bridge-token": token },
        body: JSON.stringify({ texts, target, model }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const retriable = res.status >= 500 && res.status < 600;
        if (retriable && attempt < MAX_ATTEMPTS) {
          console.warn(`[llm-translate] retry ${attempt}/${MAX_ATTEMPTS} after ${res.status}`);
          await sleep(1000 * attempt);
          return translateBatch(texts, { bridgeUrl, token, target, model }, attempt + 1);
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
        return translateBatch(texts, { bridgeUrl, token, target, model }, attempt + 1);
      }
      throw e;
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function doTranslate({ bridgeUrl, token, target, model }) {
    if (!token) throw new Error("token未設定。拡張のオプションで設定してください");
    // Remember settings so MutationObserver can auto re-translate on SPA nav.
    state.lastSettings = { bridgeUrl, token, target, model };

    // Seed the hot cache from localStorage for this target language (once).
    if (state.persistBucketKey !== bucketKeyFor(target)) seedCacheFromPersisted(target);

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
          translations = await translateBatch(batch, { bridgeUrl, token, target, model });
        } catch (e) {
          console.error(`[llm-translate] [w${wid}] batch ${idx} failed:`, e);
          completed++;
          safeSend({ progress: { current: completed, total: batches.length } });
          continue;
        }
        // Fill cache with results (in-memory + persist to localStorage debounced).
        batch.forEach((src, i) => {
          const tr = translations[i];
          if (typeof tr === "string") {
            state.cache.set(src, tr);
            persistPut(src, tr);
          }
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
   * Also watches for SPA URL changes (Vue Router history.pushState) and
   * resets state on route change so we re-scan the fresh page from scratch.
   */
  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      // Detect SPA route change: URL changed but no full page load.
      if (state.lastUrl && state.lastUrl !== location.href) {
        console.log(`[llm-translate] SPA route change: ${state.lastUrl} -> ${location.href}`);
        // Wipe per-page state: cached blocks refer to the old DOM's elements,
        // which no longer exist. Keep the in-memory translation cache — text
        // that repeats across pages is still valid.
        state.blocks = [];
        state.lastUrl = location.href;
      }
      scheduleReTranslate();
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    });
    state.lastUrl = location.href;
    console.log("[llm-translate] MutationObserver armed at", state.lastUrl);
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
        else if (msg.action === "buildMarkdown") sendResponse(await doBuildMarkdown(msg));
        else sendResponse({ ok: false, error: "unknown action" });
      } catch (e) {
        safeSend({ failed: { error: e.message } });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  });

  // -----------------------------------------------------------------
  // Copy-as-Markdown: takes the CURRENT (translated) DOM of the main
  // content area, converts to Markdown via turndown, inlines images as
  // base64, prepends a metadata header.
  // -----------------------------------------------------------------
  async function doBuildMarkdown(_msg) {
    if (typeof TurndownService === "undefined") {
      return { ok: false, error: "turndown 未ロード" };
    }

    // 1. Locate the main content region.
    const mainEl = findMainContent();
    if (!mainEl) return { ok: false, error: "本文エリアが見つからない" };

    // 2. Deep-clone so we can rewrite <img> src to base64 without polluting the page.
    const clone = mainEl.cloneNode(true);

    // 3. Inline all images as base64 (in parallel).
    // Note: querySelectorAll on clone finds imgs in the cloned subtree only.
    // If the main element ITSELF is a small wrapper without imgs, we widen to
    // the closest ancestor that DOES have imgs (still on the live DOM).
    let imgs = Array.from(clone.querySelectorAll("img"));
    console.log(`[llm-translate] main container: <${mainEl.tagName}${mainEl.className ? "." + String(mainEl.className).split(/\s+/).slice(0, 2).join(".") : ""}> — <img> found: ${imgs.length}`);
    let attempts = 0;
    let ok = 0;
    let alreadyData = 0;
    const errorReasons = new Map();
    const results = await Promise.allSettled(imgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      if (src.startsWith("data:")) { alreadyData++; return; }
      attempts++;
      try {
        const dataUrl = await fetchAsDataUrl(new URL(src, location.href).href);
        img.setAttribute("src", dataUrl);
        ok++;
      } catch (e) {
        const reason = e.message || String(e);
        errorReasons.set(reason, (errorReasons.get(reason) || 0) + 1);
        console.warn(`[llm-translate] image inline failed: ${src.slice(0, 80)} — ${reason}`);
      }
    }));
    if (errorReasons.size > 0) {
      console.warn(`[llm-translate] image error breakdown:`, Object.fromEntries(errorReasons));
    }
    console.log(`[llm-translate] image summary: ${imgs.length} total, ${alreadyData} already data:, ${attempts} fetched, ${ok} succeeded`);
    const imageOk = ok + alreadyData;

    // 4. Configure turndown.
    const td = new TurndownService({
      headingStyle: "atx",           // # H1 / ## H2
      codeBlockStyle: "fenced",      // ```
      bulletListMarker: "-",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });
    // Preserve GFM tables (turndown drops <table> by default).
    td.addRule("table", {
      filter: "table",
      replacement: (_content, node) => htmlTableToMarkdown(node),
    });
    // Strip <button> / <nav> / <script> / <style> that snuck in.
    td.remove(["script", "style", "nav", "button", "aside", "iframe"]);

    const bodyMd = td.turndown(clone.innerHTML).trim();

    // 5. Build the header.
    const title = (document.title || "").trim() || "(タイトルなし)";
    const url = location.href;
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const header = [
      `# ${title}`,
      ``,
      `> 出典: ${url}`,
      `> 取得日: ${dateStr}`,
      ``,
      `---`,
      ``,
    ].join("\n");

    const markdown = header + bodyMd + "\n";
    console.log(`[llm-translate] markdown built: ${markdown.length} chars, ${imageOk}/${imgs.length} images inlined`);
    return { ok: true, markdown, imageCount: imageOk };
  }

  // Auto-detect the main text container by SCORING candidate elements.
  // Score = text length * 1 + <p>/<li> count * 200 + <img> count * 100
  //         - <nav>/<header>/<footer>/<button> in subtree * 500 (penalize chrome)
  // Pick the highest-scoring element. Falls back to body if nothing scores well.
  function findMainContent() {
    // Named selectors first — if they exist AND have real content, prefer them.
    const namedSelectors = [
      ".markdown-content", ".prose",
      "article", "main", "[role='main']",
      "#content", "#main", ".content", ".post-content",
    ];
    const namedHits = [];
    for (const sel of namedSelectors) {
      document.querySelectorAll(sel).forEach((el) => namedHits.push(el));
    }

    // Also consider any <div> with a lot of <p>/<img> — for SPAs like offsec.com
    // where the content wrapper has generic class names.
    const genericCandidates = Array.from(document.querySelectorAll("div, section")).filter((el) => {
      const paras = el.querySelectorAll("p, li, h1, h2, h3").length;
      const imgs = el.querySelectorAll("img").length;
      return paras + imgs >= 5;
    });

    const all = [...new Set([...namedHits, ...genericCandidates])];
    if (all.length === 0) return document.body;

    let best = null;
    let bestScore = -Infinity;
    for (const el of all) {
      const txtLen = el.textContent.trim().length;
      if (txtLen < 200) continue;
      const paras = el.querySelectorAll("p, li, h1, h2, h3, h4").length;
      const imgs = el.querySelectorAll("img").length;
      // Penalize elements that also contain navigation chrome — that means we
      // grabbed too high (like the root #app).
      const chrome = el.querySelectorAll("nav, header, footer").length;
      const score = txtLen + paras * 200 + imgs * 100 - chrome * 500;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    console.log(`[llm-translate] findMainContent: picked <${best?.tagName || "BODY"}${best?.className ? "." + String(best.className).split(/\s+/).slice(0, 3).join(".") : ""}> score=${bestScore}`);
    return best || document.body;
  }

  // Fetch a URL and return a data: URL.
  // Strategy: content-script fetch first (fast, uses page cookies).
  // If that fails (usually CORS on cross-origin CDN), fall back to service-worker
  // fetch via chrome.runtime.sendMessage — the extension context has
  // host_permissions <all_urls> so CORS doesn't apply.
  async function fetchAsDataUrl(url) {
    // Direct attempt
    try {
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const blob = await res.blob();
        return await blobToDataUrl(blob);
      }
    } catch { /* fall through to background fetch */ }

    // Background service worker fallback
    const bg = await chrome.runtime.sendMessage({ action: "fetchImageAsDataUrl", url });
    if (bg?.ok) return bg.dataUrl;
    throw new Error(bg?.error || "both direct and background fetch failed");
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // Minimal GFM table converter. Handles <thead>/<tbody>, falls back to first
  // row as header if no <thead>.
  function htmlTableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length === 0) return "";
    const cellsOf = (tr) => Array.from(tr.querySelectorAll("th,td")).map((c) => c.textContent.replace(/\s+/g, " ").trim());
    const headerFromThead = table.querySelector("thead tr");
    let headers, bodyRows;
    if (headerFromThead) {
      headers = cellsOf(headerFromThead);
      bodyRows = rows.filter((r) => !headerFromThead.contains(r) && r !== headerFromThead).map(cellsOf);
    } else {
      headers = cellsOf(rows[0]);
      bodyRows = rows.slice(1).map(cellsOf);
    }
    const width = headers.length;
    const sep = "| " + Array(width).fill("---").join(" | ") + " |";
    const head = "| " + headers.join(" | ") + " |";
    const body = bodyRows.map((r) => {
      const padded = r.concat(Array(Math.max(0, width - r.length)).fill(""));
      return "| " + padded.slice(0, width).join(" | ") + " |";
    }).join("\n");
    return "\n" + [head, sep, body].join("\n") + "\n";
  }

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
