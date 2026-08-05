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
const MODEL = process.env.MODEL || "opus";
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

function buildPrompt(texts, source, target) {
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join("\n---\n");
  return [
    `You are a translation API. You MUST return ONLY a JSON array of strings, nothing else.`,
    ``,
    `Task: translate ${texts.length} numbered snippets from ${source} to ${target}.`,
    ``,
    `Rules:`,
    `- Preserve original meaning, tone, and inline formatting (HTML tags, markdown, punctuation, whitespace).`,
    `- If a snippet is already in ${target}, copy it into the output unchanged (still as a JSON string in the array).`,
    `- NEVER add commentary, notes, explanations, or [index] prefixes to the output.`,
    `- NEVER wrap the output in markdown code fences or prose.`,
    `- The response MUST start with '[' and end with ']'.`,
    `- The array MUST have EXACTLY ${texts.length} string elements, in the same order as the input.`,
    ``,
    `Input:`,
    numbered,
    ``,
    `Now output the JSON array of ${texts.length} translations:`,
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
  const trimmed = raw.trim();

  // 1) Try direct JSON parse
  let arr = tryJson(trimmed);

  // 2) Try to extract the first well-formed [...] block (Claude sometimes prepends prose)
  if (!arr) {
    const m = trimmed.match(/\[[\s\S]*\]/);
    if (m) arr = tryJson(m[0]);
  }

  // 3) Fallback: parse the "[N] translation\n---\n[N+1] ..." plain-text format
  //    (Claude occasionally echoes the input format instead of returning JSON.)
  if (!arr) {
    arr = parseIndexedFallback(trimmed, expectedLen);
    if (arr) console.warn(`[translate] used indexed-fallback parser (JSON parse failed)`);
  }

  if (!arr) {
    throw new Error(`failed to parse translations from claude output.\nraw: ${raw.slice(0, 500)}`);
  }
  if (arr.length !== expectedLen) {
    console.warn(`[translate] length mismatch: got ${arr.length}, expected ${expectedLen}`);
  }
  return arr.map((x) => String(x));
}

function tryJson(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Parse the "[0] foo\n---\n[1] bar\n---\n[2] baz" style Claude sometimes emits.
function parseIndexedFallback(raw, expectedLen) {
  const parts = raw.split(/\n?---\n?/);
  const out = new Array(expectedLen).fill("");
  let matched = 0;
  for (const part of parts) {
    const m = part.match(/^\s*\[(\d+)\]\s*([\s\S]*?)\s*$/);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx >= 0 && idx < expectedLen) {
      out[idx] = m[2];
      matched++;
    }
  }
  return matched > 0 ? out : null;
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
