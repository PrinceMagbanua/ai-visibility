# EBOS AI Visibility Tracker

A minimal DIY tracker for how EBOS MedTech, LifeHealthcare and Transmedic show up in
Claude's answers to realistic buyer/procurement prompts. Runs weekly via GitHub Actions,
commits results back into `results/` as dated JSON files so history lives in git.

## What it does

**Brand-visibility check** — for each prompt in `config/prompts.json`:
1. Asks Claude (with web search enabled) the prompt, as a real user would.
2. Asks Claude a second time to analyze that answer: is each tracked brand
   (`config/brands.json`) mentioned, roughly where, what sentiment, and what
   other companies show up.

**Page-citation check** — for each entry in `config/pages.json` (a homepage +
one article/product page per brand):
1. Asks Claude the page's associated search-style question (with web search
   enabled).
2. Checks whether that specific tracked URL (or its domain) shows up among
   the citations returned — a direct signal for whether a given page,
   including any JSON-LD on it, is actually surfacing in AI answers.

Both checks write into a single combined `results/<date>.json` per run.

## Setup

1. `npm install`
2. Add `ANTHROPIC_API_KEY` as a GitHub Actions secret on this repo
   (Settings → Secrets and variables → Actions → New repository secret).
3. **If your API key is an identity-linked (workspace-member) key** — you'll
   see a 400 error `anthropic-workspace-id is required` if so — also add an
   `ANTHROPIC_WORKSPACE_ID` secret with your workspace's ID (found in the
   Anthropic Console under workspace settings; the ID starts with `wrkspc_`).
   Standalone/legacy API keys don't need this.
4. The workflow in `.github/workflows/weekly-visibility-check.yml` runs every
   Monday. Trigger it manually any time via the Actions tab ("Run workflow").

**Evaluation-tier / low rate-limit keys:** the script spaces out API calls
(default 5 seconds between requests, plus exponential backoff retries on
429s) via `API_CALL_DELAY_MS`. If you're still hitting rate limits, raise it
(e.g. `API_CALL_DELAY_MS=10000` as a repo variable/secret passed into the
workflow's `env`), or trim `config/prompts.json` down to fewer prompts —
each prompt costs 2 API calls, each tracked page costs 1.

To run locally:

```
ANTHROPIC_API_KEY=sk-... npm run check
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

## Known gaps vs. a paid tool

- Single AI engine (Claude only) — no ChatGPT/Gemini/Perplexity coverage.
- No crawler-log or GA4-referral tracking (separate, manual check).
- No historical dashboard — just JSON files; build a small script over
  `results/*.json` if you want trend charts.
# ebos-visibility
# ai-visibility
