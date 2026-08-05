// llm-translate-bridge / bridge
// Local HTTPS server that shells out to `claude -p` (Claude Code CLI) to translate text.
// Uses the user's Max subscription auth (~/.claude/credentials.json). No API key required.
//
// Two modes:
//   MODE=local     — HTTP  on 127.0.0.1:PORT (single-machine use)
//   MODE=tailscale — HTTPS on <tailscale-ip>:PORT with MagicDNS cert (default)

import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODE = process.env.MODE || "tailscale";
const PORT = Number(process.env.PORT || 17891);
const MODEL = process.env.MODEL || "sonnet";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const TAILSCALE_IP = process.env.TAILSCALE_IP || "100.104.251.67";
const TAILSCALE_HOST = process.env.TAILSCALE_HOST || "home-tuyotuyo.tailf8de78.ts.net";
const CERT_PATH = process.env.CERT_PATH || join(__dirname, "certs", "tailscale.crt");
const KEY_PATH = process.env.KEY_PATH || join(__dirname, "certs", "tailscale.key");

const HOST = MODE === "local" ? "127.0.0.1" : TAILSCALE_IP;

// Auth token resolution order:
//   1. env BRIDGE_TOKEN (explicit override, wins over everything)
//   2. ~/.llm-translate-bridge/token from a previous run (persistent)
//   3. freshly generated 16-byte hex (first-run only), then persisted
// This way, restarting the bridge does NOT force re-pasting the token into the extension.
const stateDir = join(homedir(), ".llm-translate-bridge");
mkdirSync(stateDir, { recursive: true });
const tokenPath = join(stateDir, "token");

let TOKEN;
let tokenSource;
if (process.env.BRIDGE_TOKEN) {
  TOKEN = process.env.BRIDGE_TOKEN.trim();
  tokenSource = "env BRIDGE_TOKEN";
} else if (existsSync(tokenPath)) {
  const saved = readFileSync(tokenPath, "utf8").trim();
  if (saved && /^[a-f0-9]{16,}$/i.test(saved)) {
    TOKEN = saved;
    tokenSource = `reused from ${tokenPath}`;
  }
}
if (!TOKEN) {
  TOKEN = randomBytes(16).toString("hex");
  tokenSource = "newly generated";
}
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });

const app = express();
app.use(express.json({ limit: "2mb" }));

// Access log — every request, including OPTIONS preflights, gets logged with timing.
app.use((req, res, next) => {
  const start = Date.now();
  const origin = req.get("origin") || "-";
  const ua = (req.get("user-agent") || "-").slice(0, 40);
  console.log(`[req ] ${req.method} ${req.path}  origin=${origin}  ua=${ua}`);
  res.on("finish", () => {
    console.log(`[resp] ${req.method} ${req.path}  ${res.statusCode}  ${Date.now() - start}ms`);
  });
  next();
});
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow chrome-extension://* and no-origin (curl / same-origin health checks).
      // Also allow https/http origins because when the extension fires from a content
      // script the browser sends the page's origin, not chrome-extension://.
      if (!origin) return cb(null, true);
      if (origin.startsWith("chrome-extension://")) return cb(null, true);
      if (origin.startsWith("http://") || origin.startsWith("https://")) return cb(null, true);
      return cb(new Error("origin not allowed"));
    },
    // Preflight: allow our custom auth header.
    allowedHeaders: ["Content-Type", "x-bridge-token"],
  }),
);

// Auth middleware — every non-health request needs the token
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const header = req.get("x-bridge-token");
  if (header !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, mode: MODE, version: "0.2.0" });
});

/**
 * POST /translate
 * body: { texts: string[], target: string (e.g. "ja"), source?: string }
 * returns: { translations: string[] }
 */
app.post("/translate", async (req, res) => {
  const { texts, target = "ja", source = "auto" } = req.body || {};
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: "texts must be a non-empty array" });
  }
  if (texts.some((t) => typeof t !== "string")) {
    return res.status(400).json({ error: "texts must be strings" });
  }

  console.log(`[tr  ] ${texts.length} snippet(s), target=${target}, first="${texts[0].slice(0, 60)}..."`);
  const prompt = buildPrompt(texts, source, target);
  const t0 = Date.now();

  try {
    const raw = await runClaude(prompt);
    console.log(`[tr  ] claude returned ${raw.length} chars in ${Date.now() - t0}ms`);
    const translations = parseTranslations(raw, texts.length);
    console.log(`[tr  ] parsed ${translations.length} translations, first="${translations[0]?.slice(0, 60)}..."`);
    res.json({ translations });
  } catch (err) {
    console.error("[translate] error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Use a hard delimiter format instead of JSON.
// LLMs are far more reliable at "print one translation per block separated by <<<END>>>"
// than at emitting a syntactically valid JSON array of N strings.
const DELIM = "<<<LLMT-END>>>";

function buildPrompt(texts, source, target) {
  const numbered = texts.map((t, i) => `<<<LLMT-${i}>>>\n${t}\n${DELIM}`).join("\n");
  return [
    `You are a machine translation engine. Translate ${texts.length} text blocks from ${source} to ${target}.`,
    ``,
    `INPUT FORMAT: each block is delimited like this:`,
    `<<<LLMT-N>>>`,
    `...block content...`,
    `${DELIM}`,
    ``,
    `OUTPUT FORMAT: respond with EXACTLY ${texts.length} blocks in the SAME format, in the SAME order:`,
    `<<<LLMT-0>>>`,
    `translation of block 0`,
    `${DELIM}`,
    `<<<LLMT-1>>>`,
    `translation of block 1`,
    `${DELIM}`,
    `... and so on for all ${texts.length} blocks.`,
    ``,
    `RULES:`,
    `- Preserve inline HTML, markdown, punctuation, and internal whitespace of each block.`,
    `- If a block is already in ${target}, output it unchanged (still wrapped in the delimiter format).`,
    `- Do NOT add commentary, headers, or explanations outside the delimiter blocks.`,
    `- Do NOT wrap the output in markdown code fences.`,
    ``,
    `INPUT (${texts.length} blocks):`,
    numbered,
    ``,
    `Now output ${texts.length} translated blocks:`,
  ].join("\n");
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--model", MODEL, "--output-format", "text"];
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"], shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr}`));
      resolve(stdout);
    });
    child.stdin.end(prompt);
  });
}

function parseTranslations(raw, expectedLen) {
  // Primary path: delimiter-based parsing. Find each "<<<LLMT-N>>> ... <<<LLMT-END>>>" block.
  // Regex is anchored on our custom sentinel, so stray prose Claude adds is skipped.
  const re = /<<<LLMT-(\d+)>>>\s*([\s\S]*?)\s*<<<LLMT-END>>>/g;
  const out = new Array(expectedLen).fill(null);
  let m;
  let matched = 0;
  while ((m = re.exec(raw)) !== null) {
    const idx = Number(m[1]);
    if (idx >= 0 && idx < expectedLen && out[idx] === null) {
      out[idx] = m[2];
      matched++;
    }
  }

  if (matched === 0) {
    // Last-ditch: legacy JSON array fallback (in case someone flips MODEL back to opus
    // and it emits the old shape).
    const arr = tryJson(raw.trim()) || (raw.match(/\[[\s\S]*\]/) && tryJson(raw.match(/\[[\s\S]*\]/)[0]));
    if (arr && arr.length === expectedLen) return arr.map(String);
    throw new Error(`failed to parse translations: 0/${expectedLen} delimited blocks found.\nraw: ${raw.slice(0, 400)}`);
  }

  if (matched < expectedLen) {
    console.warn(`[translate] partial parse: got ${matched}/${expectedLen} blocks (missing indexes filled with empty)`);
    for (let i = 0; i < expectedLen; i++) if (out[i] === null) out[i] = "";
  }
  return out.map(String);
}

function tryJson(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ------ start server ------

function start() {
  if (MODE === "local") {
    http.createServer(app).listen(PORT, HOST, () => {
      console.log(`llm-translate-bridge (local/HTTP) listening on http://${HOST}:${PORT}`);
      printCommon();
    });
    return;
  }

  // tailscale mode: HTTPS with MagicDNS cert
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    console.error(`ERROR: cert files not found`);
    console.error(`  cert: ${CERT_PATH}`);
    console.error(`  key : ${KEY_PATH}`);
    console.error(`Re-issue with: tailscale cert ${TAILSCALE_HOST}`);
    process.exit(1);
  }
  const cert = readFileSync(CERT_PATH);
  const key = readFileSync(KEY_PATH);
  https.createServer({ cert, key }, app).listen(PORT, HOST, () => {
    console.log(`llm-translate-bridge (tailscale/HTTPS) listening on https://${TAILSCALE_HOST}:${PORT}`);
    console.log(`bind: ${HOST}:${PORT}`);
    printCommon();
  });
}

function printCommon() {
  console.log(`model: ${MODEL}`);
  console.log(`token: ${TOKEN}  (${tokenSource})`);
  console.log(`  saved to ${tokenPath}`);
  if (MODE !== "local") {
    console.log(``);
    console.log(`Extension "Bridge URL" should be:`);
    console.log(`  https://${TAILSCALE_HOST}:${PORT}`);
  }
}

start();
