import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 1024 * 1024;
const rate = new Map();

async function loadDB() {
  await mkdir(DATA_DIR, { recursive: true });
  try { return JSON.parse(await readFile(DB_FILE, "utf8")); }
  catch { const initial = { agents: [], workflows: [], runs: [] }; await saveDB(initial); return initial; }
}
let db = await loadDB();
async function saveDB(next = db) {
  db = next;
  await writeFile(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}
function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > MAX_BODY) { reject(new Error("Request body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON body")); } });
    req.on("error", reject);
  });
}
function safeString(value, max = 8000) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function rateLimited(req) {
  const ip = req.socket.remoteAddress || "unknown", now = Date.now();
  const bucket = (rate.get(ip) || []).filter(t => now - t < 60_000);
  bucket.push(now); rate.set(ip, bucket);
  return bucket.length > 60;
}
function mime(file) {
  return ({ ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".ico":"image/x-icon" })[path.extname(file)] || "application/octet-stream";
}
async function staticFile(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const normalized = path.posix.normalize(requested);
  if (normalized.split("/").some(part => part.startsWith(".")) || ["/server.js", "/package.json"].includes(normalized) || normalized.startsWith("/data/")) {
    return json(res, 404, { error: "Not found" });
  }
  const file = path.resolve(ROOT, "." + normalized);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return json(res, 403, { error: "Forbidden" });
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": mime(file), "x-content-type-options": "nosniff" });
    res.end(body);
  } catch { json(res, 404, { error: "Not found" }); }
}
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "AI Agent Studio API", aiConfigured: Boolean(process.env.OPENAI_API_KEY), provider: process.env.AI_PROVIDER || "openai" });
  }
  if (pathname.startsWith("/api/")) {
    if (rateLimited(req)) return json(res, 429, { error: "Too many requests. Please wait a minute and try again." });
    if (req.method === "GET" && pathname === "/api/agents") return json(res, 200, { agents: db.agents });
    if (req.method === "POST" && pathname === "/api/agents") {
      const body = await readBody(req);
      const name = safeString(body.name, 100);
      if (!name) return json(res, 400, { error: "Agent name is required." });
      const agent = { id: randomUUID(), name, role: safeString(body.role, 120) || "General", goal: safeString(body.goal, 1000), instructions: safeString(body.instructions, 12000), model: safeString(body.model, 100) || process.env.OPENAI_MODEL || "gpt-4o-mini", provider: safeString(body.provider, 40) || "openai", status: "Draft", runs: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.agents.unshift(agent); await saveDB();
      return json(res, 201, { agent });
    }
    const agentMatch = pathname.match(/^\/api\/agents\/([\w-]+)$/);
    if (agentMatch && req.method === "PATCH") {
      const agent = db.agents.find(a => a.id === agentMatch[1]);
      if (!agent) return json(res, 404, { error: "Agent not found." });
      const body = await readBody(req);
      for (const key of ["name", "role", "goal", "instructions", "model", "provider", "status"]) if (body[key] !== undefined) agent[key] = safeString(body[key], key === "instructions" ? 12000 : 1000);
      agent.updatedAt = new Date().toISOString(); await saveDB();
      return json(res, 200, { agent });
    }
    if (agentMatch && req.method === "DELETE") {
      const before = db.agents.length; db.agents = db.agents.filter(a => a.id !== agentMatch[1]);
      if (before === db.agents.length) return json(res, 404, { error: "Agent not found." });
      await saveDB(); return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && pathname === "/api/workflows") return json(res, 200, { workflows: db.workflows });
    if (req.method === "POST" && pathname === "/api/workflows") {
      const body = await readBody(req);
      const workflow = { id: randomUUID(), name: safeString(body.name, 100) || "Untitled workflow", nodes: Array.isArray(body.nodes) ? body.nodes.slice(0, 100) : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      db.workflows.unshift(workflow); await saveDB(); return json(res, 201, { workflow });
    }
    if (req.method === "POST" && pathname === "/api/chat") {
      const body = await readBody(req);
      const message = safeString(body.message, 12000);
      if (!message) return json(res, 400, { error: "Message is required." });
      const agent = db.agents.find(a => a.id === body.agentId) || null;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return json(res, 503, { error: "AI provider is not configured yet. Add OPENAI_API_KEY to your .env file, then restart the server." });
      const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
      const model = safeString(body.model, 100) || agent?.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
      const messages = Array.isArray(body.history) ? body.history.slice(-20).filter(m => ["user", "assistant"].includes(m.role)).map(m => ({ role: m.role, content: safeString(m.content, 12000) })) : [];
      messages.push({ role: "user", content: message });
      const upstream = await fetch(base + "/chat/completions", {
        method: "POST", headers: { "authorization": "Bearer " + apiKey, "content-type": "application/json" },
        body: JSON.stringify({ model, temperature: 0.7, messages: [{ role: "system", content: agent?.instructions || "You are a helpful AI assistant. Be accurate, clear, and concise." }, ...messages] })
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return json(res, upstream.status === 429 ? 429 : 502, { error: result.error?.message || "The AI provider request failed." });
      const reply = result.choices?.[0]?.message?.content;
      if (!reply) return json(res, 502, { error: "The AI provider returned an empty response." });
      if (agent) { agent.runs = (agent.runs || 0) + 1; agent.updatedAt = new Date().toISOString(); await saveDB(); }
      db.runs.unshift({ id: randomUUID(), agentId: agent?.id || null, model, createdAt: new Date().toISOString(), status: "completed" });
      db.runs = db.runs.slice(0, 500); await saveDB();
      return json(res, 200, { reply, model, usage: result.usage || null });
    }
    return json(res, 404, { error: "API route not found." });
  }
  return staticFile(req, res, pathname);
}
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) json(res, 500, { error: err.message || "Internal server error" });
    else res.end();
    console.error("[request]", err);
  });
});
server.listen(PORT, HOST, () => console.log(`AI Agent Studio running at http://localhost:${PORT}`));
