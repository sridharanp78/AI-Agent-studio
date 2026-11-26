# AI Agent Studio

A self-hosted AI agent workspace with a dark dashboard, agent builder, workflow canvas, playground, knowledge/integration screens, and a small Node.js API.

## Requirements
- Node.js 20 or newer
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

No third-party npm packages are required. Agent and workflow records are stored in `data/db.json`.

## API
- `GET /api/health` — service and provider configuration status.
- `GET /api/agents` — list saved agents.
- `POST /api/agents` — create an agent.
- `PATCH /api/agents/:id` — update an agent.
- `DELETE /api/agents/:id` — delete an agent.
- `GET /api/workflows` and `POST /api/workflows` — list/create workflows.
- `POST /api/workflows/run` — execute a workflow graph on the backend. Trigger, Agent, Condition, Transform and one-pass Loop nodes are supported. Agent nodes call the configured OpenAI-compatible provider. Tool Call nodes stop safely with a `blocked` result until an integration is connected.
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
The dashboard, agent builder, node canvas, and playground are frontend foundations. Live chat and Agent workflow nodes use the configured OpenAI-compatible provider when the backend is deployed and configured. External tool/MCP execution, team permissions, vector search/RAG, and production deployment hardening are not implemented yet.

## Security note
This starter does not yet include user authentication, workspace isolation, or production-grade authorization. Run it on your own machine or behind a trusted private network only. Do not expose the API directly to the public internet until authentication, authorization, HTTPS, secret management, and deployment hardening have been added. The server deliberately does not serve `.env`, `server.js`, or the local `data/` directory as static files.

## App access protection
The app requires `APP_ACCESS_USER` and `APP_ACCESS_PASSWORD` before serving the UI or API. The browser will show a standard sign-in prompt. Set a long, unique password in your deployment provider's secret environment variables. Do not commit real credentials.

## Deploy on Render
A `render.yaml` Blueprint is included. In Render, create a new Blueprint and select this GitHub repository. Set the secret values for `APP_ACCESS_USER`, `APP_ACCESS_PASSWORD`, and (if you want live AI chat) `OPENAI_API_KEY`. The health endpoint is `/api/health`. The free Render filesystem is ephemeral, so JSON-stored agent/workflow data may reset when the instance restarts; use a persistent disk or managed database for durable production storage.
