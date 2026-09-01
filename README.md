# EBOS AI Visibility Tracker

A minimal DIY tracker for how EBOS MedTech, LifeHealthcare and Transmedic show up in
Gemini's answers to realistic buyer/procurement prompts. Runs weekly via GitHub Actions,
commits results back into `results/` as dated JSON files so history lives in git.

Uses Google's **Gemini API free tier** (no billing account needed) — genuinely
free on an ongoing basis, not a one-time trial credit.

## What it does

**Brand-visibility check** — for each prompt in `config/prompts.json`:
1. Asks Gemini (with Google Search grounding enabled) the prompt, as a real user would.
2. Asks Gemini a second time to analyze that answer: is each tracked brand
   (`config/brands.json`) mentioned, roughly where, what sentiment, and what
   other companies show up.

**Page-citation check** — for each entry in `config/pages.json` (a homepage +
one article/product page per brand):
1. Asks Gemini the page's associated search-style question (with search grounding).
2. Checks whether that specific tracked URL (or its domain) shows up among
   the citations returned — a direct signal for whether a given page,
   including any JSON-LD on it, is actually surfacing in AI answers.

Both checks write into a single combined `results/<date>.json` per run.

## Setup

1. `npm install`
2. Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   — sign in with a Google account, accept the terms, and it generates a key
   with no payment method required for the free tier.
3. Add it as `GEMINI_API_KEY` in this repo's GitHub Actions secrets
   (Settings → Secrets and variables → Actions → New repository secret).
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

The script spaces out calls (default 5 seconds between requests) via
`API_CALL_DELAY_MS`. It does **not** retry-with-backoff on auth or quota
errors — a 401/403 immediately aborts the entire run (and fails the GitHub
Actions job); a 429 first tries the next candidate model, and only aborts
once the whole list is exhausted, rather than burning time retrying every
remaining prompt against a quota that isn't going to recover mid-run. If
you're hitting daily quota
limits, trim `config/prompts.json` — each prompt costs 2 API calls, each
tracked page costs 1.

To run locally:

```
GEMINI_API_KEY=... npm run check
```

## Editing what's tracked

- `config/brands.json` — the brand/domain list checked in every answer.
- `config/prompts.json` — the general buyer-intent prompt list. Edit freely.
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
      "matched_citations": [{ "url": "...", "title": "..." }],
      "total_citations": 6
    }
  ]
}
```

`exact_page_cited` is the strict signal (that specific URL was cited);
`domain_cited` is looser (the site was cited, maybe a different page).
Compare a tracked page's `exact_page_cited` rate before vs. after a change
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

- Single AI engine (Gemini only) — no ChatGPT/Claude/Perplexity coverage.
- No crawler-log or GA4-referral tracking (separate, manual check).
