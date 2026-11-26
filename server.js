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
function valueAtPath(obj, path) { return String(path || "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce((v, key) => v == null ? undefined : v[key], obj); }
function getContext(value) { return value && typeof value === "object" ? (value.context && typeof value.context === "object" ? value.context : value) : {}; }
function testCondition(actual, operator, expected) {
  if (operator === "exists") return actual !== undefined && actual !== null;
  if (operator === "is_empty") return actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0) || (typeof actual === "object" && !Array.isArray(actual) && Object.keys(actual).length === 0);
  if (operator === "is_true") return actual === true || actual === 1 || String(actual).toLowerCase() === "true";
  if (operator === "is_false") return actual === false || actual === 0 || String(actual).toLowerCase() === "false";
  if (operator === "equals") return actual !== undefined && actual !== null && String(actual) === String(expected);
  if (operator === "not_equals") return actual !== undefined && actual !== null && String(actual) !== String(expected);
  if (operator === "contains") return Array.isArray(actual) ? actual.some(v => String(v).toLowerCase() === String(expected).toLowerCase()) : actual !== undefined && String(actual).toLowerCase().includes(String(expected).toLowerCase());
  if (operator === "starts_with") return actual !== undefined && String(actual).toLowerCase().startsWith(String(expected).toLowerCase());
  if (operator === "ends_with") return actual !== undefined && String(actual).toLowerCase().endsWith(String(expected).toLowerCase());
  if (operator === "greater_than" || operator === "less_than") { const a = Number(actual), b = Number(expected); return actual !== undefined && actual !== null && String(actual).trim() !== "" && Number.isFinite(a) && Number.isFinite(b) && (operator === "greater_than" ? a > b : a < b); }
  throw new Error("Unsupported condition operator: " + operator);
}
async function executeAgentNode(node, agent, input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured on the backend.");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = safeString(node.model, 100) || agent?.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const instructions = agent?.instructions || "You are a helpful AI workflow agent. Follow the task and return a useful result.";
  const task = "Execute this workflow step. Use the input JSON as source data. Return a concise, useful result.\n\nNode: " + safeString(node.title, 120) + "\nDescription: " + safeString(node.detail, 2000) + "\nInput JSON:\n" + JSON.stringify(input).slice(0, 20000);
  const upstream = await fetch(base + "/chat/completions", { method: "POST", signal: AbortSignal.timeout(45000), headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" }, body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: "system", content: instructions }, { role: "user", content: task }] }) });
  const result = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(result.error?.message || "AI provider request failed with status " + upstream.status);
  const reply = result.choices?.[0]?.message?.content;
  if (!reply) throw new Error("AI provider returned an empty response.");
  return { agent: agent?.name || null, model, reply, usage: result.usage || null };
}
function safeCalculate(expression) {
  const tokens = String(expression || "").match(/\d+(?:\.\d+)?|[()+*/%-]|\s+/g);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== String(expression || "").replace(/\s/g, "")) throw new Error("Calculator accepts only numbers and + - * / % parentheses.");
  const clean = tokens.filter(t => !/^\s+$/.test(t)); let i = 0;
  function atom() { const t = clean[i++]; if (t === "(") { const v = sum(); if (clean[i++] !== ")") throw new Error("Missing closing parenthesis."); return v; } if (t === "-") return -atom(); if (t === "+") return atom(); const n = Number(t); if (!Number.isFinite(n)) throw new Error("Invalid calculator expression."); return n; }
  function product() { let v = atom(); while (["*","/","%"].includes(clean[i])) { const op=clean[i++], b=atom(); if ((op==="/"||op==="%") && b===0) throw new Error("Division by zero."); v=op==="*" ? v*b : op==="/" ? v/b : v%b; } return v; }
  function sum() { let v=product(); while (["+","+ -"].includes(clean[i]) || clean[i]==="-") { const op=clean[i++], b=product(); v=op==="+"?v+b:v-b; } return v; }
  const value=sum(); if (i!==clean.length || !Number.isFinite(value)) throw new Error("Invalid or incomplete calculator expression."); return value;
}
async function runBuiltinTool(node, context, inputItems) {
  const tool = safeString(node.toolName, 40), value = safeString(node.toolInput, 2000);
  if (tool === "calculator") return { tool, result: safeCalculate(value), context };
  if (tool === "json_lookup") { const result=valueAtPath(context, value); return { tool, path:value, result: result === undefined ? null : result, context }; }
  if (tool === "text_template") { const result=value.replace(/\{\{\s*([\w.$\[\]]+)\s*\}\}/g, (_, path) => { const found=valueAtPath(context,path); return found == null ? "" : typeof found === "object" ? JSON.stringify(found) : String(found); }); return { tool, result, context }; }
  if (tool === "slack_webhook") {
    const configured = process.env.SLACK_WEBHOOK_URL;
    if (!configured) throw new Error("SLACK_WEBHOOK_URL is not configured on the backend.");
    let endpoint; try { endpoint = new URL(configured); } catch { throw new Error("SLACK_WEBHOOK_URL is invalid."); }
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "hooks.slack.com" || endpoint.username || endpoint.password) throw new Error("Slack webhook must use an HTTPS hooks.slack.com URL.");
    const message = value.replace(/\{\{\\s*([\w.$\[\]]+)\\s*\}\}/g, (_, path) => { const found=valueAtPath(context,path); return found == null ? "" : typeof found === "object" ? JSON.stringify(found) : String(found); });
    if (!message) throw new Error("Add message text to the Slack tool input.");
    const response = await fetch(endpoint, { method:"POST", redirect:"error", signal:AbortSignal.timeout(10000), headers:{"content-type":"application/json"}, body:JSON.stringify({text:message}) });
    const responseText = await response.text();
    if (!response.ok || responseText.trim() !== "ok") throw new Error("Slack webhook failed with HTTP " + response.status + ".");
    return { tool, delivered:true, message, context };
  }
  if (tool === "combine") return { tool, result: inputItems.map(x=>x.data), context };
  throw new Error("Select a supported built-in tool before running this node.");
}
async function executeWorkflow(body) {
  const nodes = Array.isArray(body.nodes) ? body.nodes.slice(0, 100) : [];
  const links = Array.isArray(body.links) ? body.links.slice(0, 300) : [];
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
  if (!nodes.length) throw new Error("Add at least one node before running.");
  if (JSON.stringify(input).length > 20000) throw new Error("Workflow input exceeds 20 KB.");
  const byId = new Map();
  for (const n of nodes) { const id = safeString(String(n?.id ?? ""), 100); if (!id || byId.has(id)) throw new Error("Workflow nodes must have unique IDs."); if (!["Trigger", "Agent", "Condition", "Tool call", "Transform", "Loop"].includes(n.type)) throw new Error("Unsupported workflow node type."); byId.set(id, { ...n, id }); }
  const incoming = new Map(nodes.map(n => [String(n.id), []])), outgoing = new Map(nodes.map(n => [String(n.id), []]));
  for (const link of links) { const from = String(link?.from ?? ""), to = String(link?.to ?? ""); if (!byId.has(from) || !byId.has(to) || from === to) throw new Error("A workflow connection references an invalid node."); outgoing.get(from).push(to); incoming.get(to).push(from); }
  const indegree = new Map([...byId.keys()].map(id => [id, incoming.get(id).length]));
  const queue = [...byId.keys()].filter(id => indegree.get(id) === 0), order = [];
  while (queue.length) { const id = queue.shift(); order.push(id); for (const to of outgoing.get(id)) { indegree.set(to, indegree.get(to) - 1); if (indegree.get(to) === 0) queue.push(to); } }
  if (order.length !== nodes.length) throw new Error("Workflow contains a cycle. Remove a connection before running.");
  const outputs = new Map(), conditions = new Map(), steps = [], started = Date.now();
  for (const id of order) {
    const node = byId.get(id), type = node.type, parents = incoming.get(id);
    const active = parents.filter(parent => outputs.has(parent) && (() => { const edge = links.find(l => String(l.from) === parent && String(l.to) === id); return !edge?.branch || String(conditions.get(parent)) === edge.branch; })());
    if (parents.length && !active.length) { steps.push({ nodeId: id, name: safeString(node.title, 120) || type, type, status: "skipped", duration: 0 }); continue; }
    const inputItems = active.length ? active.map(parent => ({ node: safeString(byId.get(parent).title, 120) || parent, data: outputs.get(parent) })) : [{ node: "workflow input", data: { payload: input } }];
    const context = inputItems.reduce((all, item) => Object.assign(all, getContext(item.data)), {});
    const stepStart = Date.now(); let output, status = "completed", detail = "";
    if (type === "Trigger") { output = { event: "workflow.started", payload: input, context: { event: "workflow.started", payload: input } }; detail = "Trigger accepted the supplied input."; }
    else if (type === "Agent") {
      const agent = db.agents.find(a => a.id === node.agentId) || null;
      output = await executeAgentNode(node, agent, { inputs: inputItems, context });
      output.context = context; if (agent) { agent.runs = (agent.runs || 0) + 1; agent.updatedAt = new Date().toISOString(); }
      detail = "Executed through the configured AI provider.";
    } else if (type === "Condition") {
      const field = safeString(node.conditionField, 200) || "payload.message", operator = safeString(node.conditionOperator, 40) || "contains", expected = node.conditionValue ?? "Sample";
      const actual = valueAtPath(context, field), matched = testCondition(actual, operator, expected);
      conditions.set(id, matched); output = { field, operator, expected, actual: actual ?? null, matched, context };
      detail = "Condition evaluated " + (matched ? "TRUE" : "FALSE") + ".";
    } else if (type === "Transform") { output = { transformed: true, items: inputItems.map(x => x.data), context }; detail = "Wrapped incoming items; configure a transform tool for custom mapping."; }
    else if (type === "Loop") { output = { iterations: 1, items: inputItems.map(x => x.data), context }; detail = "One iteration completed; loop execution is currently a single pass."; }
    else { output = await runBuiltinTool(node, context, inputItems); detail = "Executed the selected built-in tool on the backend. No external service was called."; }
    outputs.set(id, output);
    steps.push({ nodeId: id, name: safeString(node.title, 120) || type, type, status, detail, duration: Date.now() - stepStart, inputs: inputItems, output });
    if (status === "blocked") break;
  }
  const finished = Date.now(), blocked = steps.some(x => x.status === "blocked"), completed = steps.filter(x => x.status === "completed").length;
  return { id: randomUUID(), status: blocked ? "blocked" : "completed", steps: completed, duration: finished - started, createdAt: new Date(finished).toISOString(), stepRecords: steps, outputs: Object.fromEntries(outputs), message: blocked ? "Execution stopped at an unconfigured tool node." : "Workflow completed." };
}
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "AI Agent Studio API", aiConfigured: Boolean(process.env.OPENAI_API_KEY), accessConfigured: Boolean(process.env.APP_ACCESS_USER && process.env.APP_ACCESS_PASSWORD), provider: process.env.AI_PROVIDER || "openai" });
  }
  const accessUser = process.env.APP_ACCESS_USER;
  const accessPassword = process.env.APP_ACCESS_PASSWORD;
  if (!accessUser || !accessPassword) return json(res, 503, { error: "App access is not configured. Set APP_ACCESS_USER and APP_ACCESS_PASSWORD before opening the app." });
  const auth = req.headers.authorization || "";
  let supplied = "";
  try { if (auth.startsWith("Basic ")) supplied = Buffer.from(auth.slice(6), "base64").toString("utf8"); } catch {}
  const expected = accessUser + ":" + accessPassword;
  if (supplied.length !== expected.length || !Buffer.from(supplied).equals(Buffer.from(expected))) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="AI Agent Studio", charset="UTF-8"', "cache-control": "no-store" });
    return res.end("Authentication required");
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
    if (req.method === "POST" && pathname === "/api/workflows/run") {
      const body = await readBody(req);
      try {
        const result = await executeWorkflow(body);
        db.runs.unshift({ id: result.id, type: "workflow", workflowName: safeString(body.name, 100) || "Untitled workflow", status: result.status, steps: result.steps, duration: result.duration, createdAt: result.createdAt, stepRecords: result.stepRecords });
        db.runs = db.runs.slice(0, 500);
        await saveDB();
        return json(res, result.status === "blocked" ? 207 : 200, result);
      } catch (error) {
        return json(res, 400, { error: error.message || "Workflow execution failed." });
      }
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
