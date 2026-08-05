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

// One-shot auth token: written to ~/.llm-translate-bridge/token so the extension
// can read it (via a small helper) or the user can copy-paste it into settings.
const TOKEN = randomBytes(16).toString("hex");
const stateDir = join(homedir(), ".llm-translate-bridge");
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, "token"), TOKEN, { mode: 0o600 });

const app = express();
app.use(express.json({ limit: "2mb" }));
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

  const prompt = buildPrompt(texts, source, target);

  try {
    const raw = await runClaude(prompt);
    const translations = parseTranslations(raw, texts.length);
    res.json({ translations });
  } catch (err) {
    console.error("[translate] error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

function buildPrompt(texts, source, target) {
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join("\n---\n");
  return [
    `You are a translation engine. Translate the following text snippets from ${source} to ${target}.`,
    `Rules:`,
    `- Preserve original meaning, tone, and formatting (inline HTML/markdown/whitespace).`,
    `- Do NOT add commentary, notes, or explanations.`,
    `- If a snippet is already in ${target}, return it unchanged.`,
    `- Output MUST be a single JSON array of strings, one translation per input, in the same order.`,
    `- Do not wrap the JSON in markdown code fences.`,
    ``,
    `Input snippets (each prefixed with [index]):`,
    numbered,
    ``,
    `Output: JSON array of ${texts.length} strings.`,
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
  let jsonText = trimmed;
  if (!trimmed.startsWith("[")) {
    const m = trimmed.match(/\[[\s\S]*\]/);
    if (m) jsonText = m[0];
  }
  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`failed to parse JSON from claude output: ${e.message}\nraw: ${raw.slice(0, 500)}`);
  }
  if (!Array.isArray(arr)) throw new Error("claude did not return an array");
  if (arr.length !== expectedLen) {
    console.warn(`[translate] length mismatch: got ${arr.length}, expected ${expectedLen}`);
  }
  return arr.map((x) => String(x));
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
  console.log(`token: ${TOKEN}`);
  console.log(`  (also saved to ${join(stateDir, "token")})`);
  if (MODE !== "local") {
    console.log(``);
    console.log(`Extension "Bridge URL" should be:`);
    console.log(`  https://${TAILSCALE_HOST}:${PORT}`);
  }
}

start();
