# EBOS AI Visibility Tracker

A minimal DIY tracker for how EBOS MedTech, LifeHealthcare and Transmedic show up in
Claude's answers to realistic buyer/procurement prompts. Runs weekly via GitHub Actions,
commits results back into `results/` as dated JSON files so history lives in git.

## What it does

For each prompt in `config/prompts.json`:
1. Asks Claude (with web search enabled) the prompt, as a real user would.
2. Asks Claude a second time to analyze that answer: is each tracked brand
   (`config/brands.json`) mentioned, roughly where, what sentiment, and what
   other companies show up.
3. Writes the combined result to `results/<date>.json`.

## Setup

1. `npm install`
2. Add an `ANTHROPIC_API_KEY` as a GitHub Actions secret on this repo
   (Settings → Secrets and variables → Actions → New repository secret).
3. The workflow in `.github/workflows/weekly-visibility-check.yml` runs every
   Monday. Trigger it manually any time via the Actions tab ("Run workflow").

To run locally:

```
ANTHROPIC_API_KEY=sk-... npm run check
```

## Editing what's tracked

- `config/brands.json` — the brand/domain list checked in every answer.
- `config/prompts.json` — the prompt list. Edit freely; realistic buyer-intent
  questions work best.

## Reading results

Each `results/<date>.json` is an array of:

```json
{
  "prompt": "...",
  "timestamp": "...",
  "raw_response": "...",
  "citations": [{ "url": "...", "title": "..." }],
  "analysis": {
    "brands_mentioned": [
      { "code": "EMT", "mentioned": true, "position": "early", "sentiment": "positive" }
    ],
    "competitors_mentioned": ["Stryker", "Zimmer Biomet"]
  }
}
```

Compare a given URL/page's citation rate before vs. after a change (e.g. a JSON-LD
deployment) by diffing across dated files.

## Known gaps vs. a paid tool

- Single AI engine (Claude only) — no ChatGPT/Gemini/Perplexity coverage.
- No crawler-log or GA4-referral tracking (separate, manual check).
- No historical dashboard — just JSON files; build a small script over
  `results/*.json` if you want trend charts.
# ebos-visibility
# ai-visibility
