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
- `POST /api/chat` — send a message to the configured OpenAI-compatible chat completions endpoint.

Example chat body:
```json
{ "message": "Explain vector databases", "history": [], "model": "gpt-4o-mini" }
```

## Provider configuration
The backend supports providers exposing an OpenAI-compatible `/chat/completions` endpoint. Set `OPENAI_BASE_URL` to the provider's API base URL and `OPENAI_API_KEY` to its secret key. Keep secrets in the server-side `.env`; never place them in frontend code or commit the real `.env` file.

## Current scope
The dashboard, agent builder, node canvas, and playground are frontend foundations. Live chat uses the configured provider. Workflow execution, external integrations, authentication, team permissions, vector search/RAG, and production deployment hardening are not implemented yet.
