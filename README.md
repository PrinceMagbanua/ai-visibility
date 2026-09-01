# EBOS AI Visibility Tracker

A minimal DIY tracker for how EBOS MedTech, LifeHealthcare and Transmedic show up
in AI-generated answers and AI-agent search results for realistic buyer/procurement
prompts. Runs weekly via GitHub Actions, commits results back into `results/` as
dated JSON files so history lives in git.

Uses **two free-tier providers together**, after discovering Gemini's own
built-in Google Search grounding is billing-gated on the free tier (plain
text generation isn't — only the search-tool feature is):

- **Tavily** (`@tavily/core`) does the actual web search — it has its own
  free tier, and is itself a real retrieval backend used by many AI
  agents/RAG products, so tracking raw presence there is a legitimate signal
  in its own right.
- **Gemini** (`@google/genai`, free tier, plain text calls only — no search
  tool) writes a natural-language answer using Tavily's search results as
  context, and separately analyzes that answer for brand mentions.

## What it does

**Brand-visibility check** — for each prompt in `config/prompts.json`:
1. Searches Tavily for the prompt text — records the raw ranked results
   (`tavily_results`: url, title, score, rank). This is the "does this show
   up in AI-agent search at all" signal, independent of any LLM.
2. Feeds those search results to Gemini as context and asks it to answer the
   prompt, citing sources by URL — reproducing "AI searches the web and
   answers" without depending on Gemini's own (billing-gated) grounding.
3. Asks Gemini a second time to analyze that generated answer: is each
   tracked brand (`config/brands.json`) mentioned, roughly where, what
   sentiment, and what other companies show up.

**Page-citation check** — for each entry in `config/pages.json` (a homepage +
one article/product page per brand): searches Tavily for the page's
associated question and checks whether that specific tracked URL (or its
domain) shows up in the raw ranked results. Pure Tavily, no LLM involved —
a direct "does this specific page rank for this query" signal, useful for
checking JSON-LD/SEO impact on a specific page.

Both checks write into a single combined `results/<date>.json` per run.

## Setup

1. `npm install`
2. Get a free Tavily API key at [tavily.com](https://tavily.com) (starts
   with `tvly-`) and add it as `TAVILY_API_KEY` in this repo's GitHub
   Actions secrets (Settings → Secrets and variables → Actions → New
   repository secret).
3. Get a free Gemini API key at
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — sign
   in with a Google account, accept the terms, no payment method required
   for the free tier — and add it as `GEMINI_API_KEY` the same way.
4. The workflow in `.github/workflows/weekly-visibility-check.yml` runs every
   Monday. Trigger it manually any time via the Actions tab ("Run workflow").

**Model choice matters a lot for the free tier — "Flash" vs "Flash Lite" are
very different quotas.** Checked directly at
[aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit):
plain `gemini-3.6-flash` (or `3.5-flash`, `3-flash`, etc.) is capped at just
**5 RPM / 20 requests-per-day** on the free tier — far too low for this
script's ~46 calls per run. The **Lite** variants get a much higher free
quota (`gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`: **15 RPM / 500
RPD** as of writing, confirmed working via `npm run diagnose`).

`GEMINI_MODEL` accepts a **comma-separated list** — `src/run.js` defaults to
`gemini-3.5-flash-lite,gemini-3.1-flash-lite`. It tries the first model, and
if that model's quota is exhausted mid-run, automatically switches to the
next one in the list for all subsequent calls (logged when it happens, and
recorded per-result as `model` in the output JSON). It only aborts the
whole run once every candidate in the list has hit quota. Google changes
model names/quotas often — re-check that dashboard (or run
`npm run diagnose` / the "Diagnose Gemini Quota" workflow) before assuming
a capacity error means something else, and update the `GEMINI_MODEL` list
if a model gets retired.

The script spaces out Gemini calls (default 10 seconds between requests) via
`API_CALL_DELAY_MS`. It does **not** retry-with-backoff on auth or quota
errors — a 401/403 immediately aborts the entire run (and fails the GitHub
Actions job); a 429 first tries the next candidate model, and only aborts
once the whole list is exhausted, rather than burning time retrying every
remaining prompt against a quota that isn't going to recover mid-run.

Per run: each prompt costs 1 Tavily search + 2 Gemini calls (answer +
analysis); each tracked page costs 1 Tavily search only. `TAVILY_MAX_RESULTS`
(default 5) controls how many search results are pulled per query — trim it
or `config/prompts.json` if you're hitting Tavily's free-tier credit limit.

To run locally:

```
GEMINI_API_KEY=... TAVILY_API_KEY=... npm run check
```

## Editing what's tracked

- `config/brands.json` — the brand/domain list checked in every answer.
- `config/prompts.json` — the buyer-intent prompt list. Edit freely, but
  avoid prompts that name a brand outright (e.g. "What is EBOS MedTech?") —
  a mention there is guaranteed and would inflate the mention-rate metric
  with a signal that isn't real visibility.
- `config/pages.json` — the specific homepage + article/product page per
  brand to check for direct citation, each with its own search-style
  `question`. Add more pages (e.g. right after a JSON-LD deploy) as needed.

## Reading results

Each `results/<date>.json` looks like:

```json
{
  "timestamp": "...",
  "prompts": [
    {
      "prompt": "...",
      "model": "gemini-3.5-flash-lite",
      "tavily_results": [{ "rank": 1, "url": "...", "title": "...", "score": 0.87 }],
      "raw_response": "...",
      "citations": [{ "url": "...", "title": "..." }],
      "analysis": {
        "brands_mentioned": [
          { "code": "EMT", "mentioned": true, "position": "early", "sentiment": "positive" }
        ],
        "competitors_mentioned": ["Stryker", "Zimmer Biomet"]
      }
    }
  ],
  "page_checks": [
    {
      "code": "LHC",
      "type": "article",
      "url": "https://www.lifehealthcare.com.au/spine/",
      "question": "What spine surgery products and brands does LifeHealthcare distribute...",
      "domain_cited": true,
      "exact_page_cited": false,
      "matched_results": [{ "rank": 2, "url": "...", "title": "...", "score": 0.71 }],
      "total_results": 5
    }
  ]
}
```

`tavily_results` (prompts) / `matched_results` (page checks) are the raw
Tavily search-ranking signal — independent of Gemini entirely.
`exact_page_cited` is the strict signal (that specific URL showed up in
Tavily's results); `domain_cited` is looser (the site showed up, maybe a
different page). Compare a tracked page's `exact_page_cited` rate before vs.
after a change
(e.g. a JSON-LD deployment) by diffing across dated files.

## Dashboard (graphs, tables, history)

Every run also builds `docs/data.json` (via `src/build-dashboard.js`, wired
into the workflow after `npm run check`), which `docs/index.html` renders as:

- a line chart of brand mention rate (%) over time
- per tracked page, a table of exact/domain citation history across runs
- a table of the latest run's per-prompt brand mentions and competitors
- an all-time top-competitors table

**To view it hosted:** enable GitHub Pages on this repo — Settings → Pages →
Source: "Deploy from a branch" → Branch: `main`, folder `/docs` → Save. It'll
be live at `https://<your-username>.github.io/ai-visibility/` within a
minute or two, and updates automatically each time the workflow runs.

To regenerate and preview locally without waiting for a run:

```
node src/build-dashboard.js
# then open docs/index.html in a browser
```

## Known gaps vs. a paid tool

- Tavily's search results feed Gemini's answer, but Gemini isn't the same
  thing as ChatGPT/Perplexity/Claude actually browsing the web themselves —
  it's a reasonable proxy, not a literal "what does ChatGPT say" check.
- No crawler-log or GA4-referral tracking (separate, manual check).
