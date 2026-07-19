# Liberty County Building Dept — Staff Reference Assistant

A small internal tool that answers staff questions using the Building
Department Guide and the 2026 HB 803 legislative memo as its only
knowledge source.

## How it's structured

- `public/index.html` — the frontend (chat UI + embedded knowledge base
  + retrieval logic). No API key lives here.
- `server.js` — a tiny Express server that serves the frontend and
  proxies `/api/ask` requests to the Anthropic API, holding the API key
  server-side so it's never exposed to the browser.
- `package.json` — dependencies (just Express).

## Running locally

```
npm install
cp .env.example .env
# edit .env and paste in a real Anthropic API key
npm start
```

Then open http://localhost:3000

## Deploying to Railway

1. Push this folder to a GitHub repo (same pattern as your other
   projects — Railway auto-deploys on push).
2. In Railway, create a new project from that repo.
3. In the Railway project's Variables tab, add:
   - `ANTHROPIC_API_KEY` = your actual Anthropic API key
   (Railway sets `PORT` automatically — no need to add it yourself.)
4. Railway will run `npm start` automatically. Once it's live, staff can
   bookmark the Railway URL directly.

## Where the API key comes from

You'll need an Anthropic API key from the Claude Platform (this is
separate from your claude.ai login) — generate one at
console.anthropic.com under API Keys. Keep it only in Railway's
environment variables, never in the repo itself (`.env` is already
git-ignored).

## Updating the knowledge base

The knowledge base is the `KNOWLEDGE_BASE` array near the top of the
`<script>` block in `public/index.html` — each entry is one
{source, section, text} chunk. To add a new document, add more entries
following the same shape. No database needed at this scale; if the
knowledge base grows past roughly 50-100 chunks, the simple
keyword-matching retrieval should be swapped for real embeddings.

## Known limitations of this prototype

- Retrieval is keyword-overlap, not semantic search — good enough for
  a small, well-labeled knowledge base, but it can miss a relevant
  chunk if the question uses very different wording than the source
  text.
- No conversation memory between questions — each question is answered
  independently.
- No authentication — anyone with the URL can use it. Fine for an
  internal tool on a Railway URL nobody's guessing, but worth adding a
  simple password gate before wider rollout.
