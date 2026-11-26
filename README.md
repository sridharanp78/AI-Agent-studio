# AI Agent Studio

A self-hosted AI agent workspace with a dark dashboard, agent builder, workflow canvas, playground, knowledge/integration screens, and a small Node.js API.

## Requirements
- Node.js 20 or newer
- PostgreSQL (optional; recommended for persistent hosted data)
- An API key from an OpenAI-compatible provider for live chat (optional for browsing the interface)

## Run locally
1. Clone or download this repository.
2. Copy `.env.example` to `.env`.
3. Add your provider key to `OPENAI_API_KEY` in `.env` (leave blank to explore the UI without live AI).
4. Run:
   ```bash
   npm start
   ```
5. Open http://localhost:3000.

Install dependencies with `npm install`. Without `DATABASE_URL`, agent/workflow records are stored in `data/db.json` (local development only). With `DATABASE_URL`, the app stores agent/workflow/run state and knowledge chunks in PostgreSQL.

## API
- `GET /api/health` — service and provider configuration status.
- `GET /api/agents` — list saved agents.
- `POST /api/agents` — create an agent.
- `PATCH /api/agents/:id` — update an agent.
- `DELETE /api/agents/:id` — delete an agent.
- `GET /api/workflows` and `POST /api/workflows` — list/create workflows.
- `POST /api/workflows/run` — execute a workflow graph on the backend. Trigger, Agent, Condition, Transform and one-pass Loop nodes are supported. Agent nodes call the configured OpenAI-compatible provider. Tool Call nodes can execute backend built-ins: `calculator`, `json_lookup`, `text_template`, and `combine`. They do not make external network calls.
- `POST /api/chat` — send a message to the configured OpenAI-compatible chat completions endpoint.

Example chat body:
```json
{ "message": "Explain vector databases", "history": [], "model": "gpt-4o-mini" }
```

## Provider configuration
The backend supports providers exposing an OpenAI-compatible `/chat/completions` endpoint. Set `OPENAI_BASE_URL` to the provider's API base URL and `OPENAI_API_KEY` to its secret key. Keep secrets in the server-side `.env`; never place them in frontend code or commit the real `.env` file.

## Workflow execution
The workflow canvas offers two run modes: a local preview (simulation only) and backend execution. Backend execution sends the current nodes, directed links, and JSON test input to `POST /api/workflows/run`. Graphs are checked for cycles and processed in dependency order. Condition nodes support `contains`, `equals`, `not_equals`, `greater_than`, `less_than`, `exists`, `starts_with`, `ends_with`, `is_empty`, `is_true`, and `is_false`; outgoing Condition links use `branch: "true"` or `branch: "false"`. Agent nodes can select a saved workspace agent and optionally override its model. Run responses include per-step status, duration, inputs, outputs, and a run ID. Workflow execution records are stored in the local JSON database.

Example request body:
```json
{
  "name": "Approval routing",
  "nodes": [
    { "id": "trigger", "type": "Trigger", "title": "New request" },
    { "id": "agent", "type": "Agent", "title": "Review request", "agentId": "YOUR_AGENT_ID" }
  ],
  "links": [{ "from": "trigger", "to": "agent" }],
  "input": { "status": "pending", "amount": 125 }
}
```

## Current scope
The dashboard, agent builder, node canvas, and playground are frontend foundations. Live chat and Agent workflow nodes use the configured OpenAI-compatible provider when the backend is deployed and configured. Knowledge uploads support PDF, DOCX, TXT, MD, CSV, JSON, HTML and XML. Documents are chunked and indexed with OpenAI-compatible embeddings when an API key is configured; keyword retrieval is used when embeddings are unavailable. Agent-specific knowledge is retrieved into Playground chat context. The current built-in workflow tools execute locally on the backend and do not connect to third-party services.

## Security note
This starter does not yet include user authentication, workspace isolation, or production-grade authorization. Run it on your own machine or behind a trusted private network only. Do not expose the API directly to the public internet until authentication, authorization, HTTPS, secret management, and deployment hardening have been added. The server deliberately does not serve `.env`, `server.js`, or the local `data/` directory as static files.

## App access protection
The app requires `APP_ACCESS_USER` and `APP_ACCESS_PASSWORD` before serving the UI or API. The browser will show a standard sign-in prompt. Set a long, unique password in your deployment provider's secret environment variables. Do not commit real credentials.

## Deploy on Render
A `render.yaml` Blueprint is included. In Render, create a new Blueprint and select this GitHub repository. Set the secret values for `APP_ACCESS_USER`, `APP_ACCESS_PASSWORD`, and (if you want live AI chat) `OPENAI_API_KEY`. The health endpoint is `/api/health`. The Render Free web-service filesystem is ephemeral. Configure `DATABASE_URL` to a PostgreSQL database to persist app state and knowledge chunks; set `PGSSLMODE=require` only when your provider requires TLS. `PG_POOL_MAX` defaults to 5. Render Free Postgres expires 30 days after creation and is not permanent storage, has no backups, and has a 1 GB limit. Use it only for a short test; use a database with retention/backups for lasting data. Free web services spin down after 15 minutes of inactivity.


## Built-in workflow tools
Select a Tool call node to configure one of these server-side operations:
- **Calculator** — arithmetic only, for example `(125 * 1.18) + 10`. Arbitrary code is not evaluated.
- **JSON field lookup** — read a dot/bracket path from workflow context, for example `payload.items[0].status`.
- **Text template** — interpolate values with placeholders such as `Request status: {{payload.status}}`.
- **Combine inputs** — return the data received from connected upstream nodes.
- **Send Slack message** — post a rendered message to a Slack incoming webhook. Set `SLACK_WEBHOOK_URL` as a private backend environment variable; only HTTPS `hooks.slack.com` webhook URLs are accepted.

These tools run inside the Node.js backend. The Slack tool is a real external action and sends a message when configured. Other tools do not send email, access arbitrary URLs, or connect to MCP servers. Store `SLACK_WEBHOOK_URL` only in the backend environment; never place it in workflow JSON or frontend code.


## MCP server discovery
The Integrations and Tools & models pages can discover tools exposed by administrator-configured MCP servers. Configure these backend-only variables:
- `MCP_SERVERS_JSON` — JSON array, for example `[{"name":"Internal MCP","url":"https://mcp.example.com/mcp","tokenEnv":"INTERNAL_MCP_TOKEN","allowedTools":["read_status"]}]`.
- `MCP_ALLOWED_HOSTS` — comma-separated exact hostnames allowed to receive MCP requests, for example `mcp.example.com`.
- `INTERNAL_MCP_TOKEN` — optional bearer token referenced by `tokenEnv`; keep it in the hosting provider's secret settings.

Discovery uses HTTPS only, rejects hostnames not in the explicit allowlist, rejects private/reserved DNS results, blocks redirects, and applies a request timeout. MCP tools can be invoked from a workflow Tool call node by selecting `mcp_tool`, then entering the exact configured server name, discovered tool name, and JSON arguments. Each server must explicitly list permitted tool names in its `allowedTools` array. Argument templates such as `{{payload.query}}` are interpolated from workflow context. The backend re-discovers the tool schema, checks required fields and basic JSON types, then calls the selected tool. This is an external action: only enable trusted servers and tools, and test with non-destructive tools first. MCP tools can also be assigned to individual agents and called from the Playground. The model can select among the agent's assigned tools; the backend enforces the administrator allowlist.


## Assign MCP tools to an agent
1. Configure an MCP server in the backend using `MCP_SERVERS_JSON`, `MCP_ALLOWED_HOSTS`, and its private token environment variable.
2. Add each permitted MCP tool name to that server's `allowedTools` array.
3. Open **Agents**, edit an agent, and set **Assigned MCP tools (JSON)**. Example:
   ```json
   [{"server":"Example MCP","tool":"read_status"}]
   ```
4. Save the agent and select it in **Playground**. Ask a question that requires the tool.

The model can choose among only the tools assigned to that agent. The backend validates the server allowlist again, re-discovers the selected tool schema, checks arguments, and invokes it. Tool activity appears below the assistant response and in the run records. Tool calls are external side effects; grant only the minimum required tools and use read-only tools first. This feature requires the authenticated Node.js backend and an OpenAI-compatible model that supports function/tool calling. The static frontend preview cannot execute tools.


## Knowledge base and retrieval
- `GET /api/knowledge` lists uploaded document metadata.
- `POST /api/knowledge` accepts `{ "name": "guide.pdf", "mimeType": "application/pdf", "contentBase64": "..." }` (5 MB per file).
- `DELETE /api/knowledge/:id` removes a document and detaches it from agents.
- Agent create/update accepts `knowledgeIds: ["document-id"]`.
- Chat retrieves up to five relevant chunks from the selected agent's assigned documents. Configure `OPENAI_API_KEY`; embeddings use `text-embedding-3-small` by default and can be changed with `OPENAI_EMBEDDING_MODEL`. Embedding requests are batched in groups of 64. If no key is configured, retrieval falls back to keyword matching. Embedding API usage may incur provider charges.


## PostgreSQL storage
Set `DATABASE_URL` on the backend service to enable PostgreSQL persistence. On first startup, the app creates `app_state` and `knowledge_documents` tables and migrates existing `data/db.json` state and knowledge chunks if present. Agent, workflow, run and knowledge metadata is stored in PostgreSQL; knowledge chunks and embeddings are stored in a separate table. When `DATABASE_URL` is absent, the app falls back to local JSON files, which are ephemeral on hosted free services. Optional settings: `PGSSLMODE=require` for TLS-required database providers and `PG_POOL_MAX=5` to tune the connection pool.
