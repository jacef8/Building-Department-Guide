# Liberty County Building Dept — Permit Assistant

Answers permit questions from the county's own documents and nothing else.
It runs in two versions off the same codebase:

- **Public** (`/`) — locked down, heavily caveated, general information only.
- **Staff** (`/staff`) — the fuller internal counter assistant, behind the
  shared office password.

Which version you get is decided by the URL and enforced on the server, so a
lingering login cookie can never turn the public site into the staff view.

## What it can do

- Answer a single lookup ("what's the fee for a residential roofing permit?")
  from the knowledge base, with clickable citations back to the source PDF.
- Walk through a **whole project** step by step ("what are the steps and
  permits for building a pole barn house?") — ordered steps with a plain-language
  reason for each one, a permit/form checklist, and an estimated fee table.
- Handle **follow-up questions** — the previous turns of the conversation are
  sent along, so "what about commercial?" works.
- Keep a **history** of past conversations, so staff can reopen an answer they
  gave last week instead of re-asking.
- Look up a parcel: type a parcel number and it pulls the designation,
  owner, legal description, and acreage from Florida DOR statewide data.

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
following the same shape and add the source to `DOC_LINKS` if there's a PDF
to cite. No database needed at this scale.

Note the `Office Procedure` entries: those aren't from a PDF, they capture
the order of operations staff actually walk applicants through (Planning &
Zoning first, then the building permit). The printed guide documents each
permit on its own and never states that sequence, so without these the
assistant would skip the first step an applicant has to take.

## How whole-project questions are handled

A question like "what are the steps and permits for building a pole barn
house, and what does it cost?" touches half the knowledge base at once, so
it gets different treatment:

1. `isGuideQuestion()` in `public/index.html` spots the intent.
2. `expandQuery()` adds the vocabulary the documents actually use — an
   applicant writes "pole barn house," the documents say "accessory
   building," "Notice of Commencement," "setbacks." This is an explicit,
   reviewable table, not a model guess.
3. Retrieval widens from 5 chunks to 16.
4. The server appends `GUIDE_FORMAT` to that mode's guardrails, asking for
   ordered steps (each with a plain-language reason it exists), a checklist,
   and a fee table — and raises the token ceiling so the answer fits.

`FEE_RULES` applies to every answer in both modes: any answer with more than
one dollar figure has to open by saying the amounts are estimates and to call
the department to confirm, present them as a table, and total only the fixed
amounts it actually listed.

## Known limitations

- Retrieval is keyword-overlap, not semantic search. The expansion table
  above covers the common project wordings, but an unusual phrasing can
  still miss a chunk. Past roughly 100 chunks this should move to real
  embeddings.
- Conversation history is per-browser (`localStorage`) — it isn't synced
  between machines and it isn't a county record. Clearing browser data
  clears it.
- Fee totals are only as good as the fee schedule in the knowledge base;
  every answer says so, but the knowledge base still has to be kept current.
