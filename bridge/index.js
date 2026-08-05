// llm-translate-bridge / bridge
// Local HTTP server that shells out to `claude -p` (Claude Code CLI) to translate text.
// Uses the user's Max subscription auth (~/.claude/credentials.json). No API key required.

import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 17891);
const HOST = "127.0.0.1";
const MODEL = process.env.MODEL || "opus";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

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
      // Allow chrome-extension://* and no-origin (curl / same-origin health checks)
      if (!origin || origin.startsWith("chrome-extension://")) return cb(null, true);
      return cb(new Error("origin not allowed"));
    },
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
  res.json({ ok: true, model: MODEL, version: "0.1.0" });
});

/**
 * POST /translate
 * body: { texts: string[], target: string (e.g. "ja"), source?: string }
 * returns: { translations: string[] }
 *
 * All texts are batched into ONE `claude -p` call for latency + token efficiency.
 * We ask Claude to return a JSON array of translations, one per input, in order.
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
  // Number each snippet so Claude can align outputs unambiguously.
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
    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
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
  // Try direct JSON first, then extract the first [...] block if Claude added prose.
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

app.listen(PORT, HOST, () => {
  console.log(`llm-translate-bridge listening on http://${HOST}:${PORT}`);
  console.log(`model: ${MODEL}`);
  console.log(`token: ${TOKEN}  (also saved to ${join(stateDir, "token")})`);
});
