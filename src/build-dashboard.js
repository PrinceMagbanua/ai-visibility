const fs = require("fs");
const path = require("path");

const brands = require("../config/brands.json").own;

const resultsDir = path.join(__dirname, "..", "results");
const docsDir = path.join(__dirname, "..", "docs");

function loadResultFiles() {
  if (!fs.existsSync(resultsDir)) return [];
  return fs
    .readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const date = f.replace(/\.json$/, "");
      const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8"));
      return { date, data };
    });
}

function sentimentScore(s) {
  if (s === "positive") return 1;
  if (s === "neutral") return 0;
  if (s === "negative") return -1;
  return null; // not_mentioned
}

// Only "buyer_intent" prompts (unbranded, generic questions a real customer
// would ask) feed the visibility metric. "brand_direct" prompts (e.g. "What
// is EBOS MedTech?") trivially guarantee a mention and would inflate the
// rate — they get their own separate brand-knowledge-check section instead.
// Older result files predate this tagging; treat untagged prompts as
// buyer_intent so historical data isn't silently dropped.
function isBuyerIntent(p) {
  return (p.type || "buyer_intent") === "buyer_intent";
}

function buildBrandTrend(files) {
  const trend = {};
  for (const b of brands) trend[b.code] = [];

  for (const { date, data } of files) {
    const prompts = (data.prompts || []).filter((p) => !p.error && p.analysis && isBuyerIntent(p));
    const total = prompts.length;

    for (const b of brands) {
      let mentionedCount = 0;
      const sentiments = [];
      for (const p of prompts) {
        const entry = (p.analysis.brands_mentioned || []).find((m) => m.code === b.code);
        if (entry?.mentioned) {
          mentionedCount++;
          const score = sentimentScore(entry.sentiment);
          if (score !== null) sentiments.push(score);
        }
      }
      const avgSentiment = sentiments.length
        ? sentiments.reduce((a, c) => a + c, 0) / sentiments.length
        : null;

      trend[b.code].push({
        date,
        total_prompts: total,
        mentioned_count: mentionedCount,
        mention_rate: total ? Math.round((mentionedCount / total) * 1000) / 10 : null,
        avg_sentiment: avgSentiment,
      });
    }
  }
  return trend;
}

function buildPageTrend(files) {
  const trend = {}; // key: "<code>-<type>"

  for (const { date, data } of files) {
    for (const check of data.page_checks || []) {
      const key = `${check.code}-${check.type}`;
      if (!trend[key]) {
        trend[key] = { code: check.code, type: check.type, url: check.url, question: check.question, points: [] };
      }
      if (check.error) {
        trend[key].points.push({ date, error: true });
      } else {
        trend[key].points.push({
          date,
          exact_page_cited: !!check.exact_page_cited,
          domain_cited: !!check.domain_cited,
          total_results: check.total_results ?? null,
        });
      }
    }
  }
  return trend;
}

function buildCompetitorTotals(files) {
  const counts = {};
  for (const { data } of files) {
    for (const p of data.prompts || []) {
      if (p.error || !p.analysis || !isBuyerIntent(p)) continue;
      for (const name of p.analysis.competitors_mentioned || []) {
        counts[name] = (counts[name] || 0) + 1;
      }
    }
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function main() {
  const files = loadResultFiles();
  const dates = files.map((f) => f.date);

  const dashboardData = {
    generated_at: new Date().toISOString(),
    dates,
    brands,
    brand_trend: buildBrandTrend(files),
    page_trend: buildPageTrend(files),
    competitor_totals: buildCompetitorTotals(files),
    latest: files.length ? files[files.length - 1].data : null,
    latest_date: files.length ? files[files.length - 1].date : null,
    run_count: files.length,
  };

  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "data.json"), JSON.stringify(dashboardData, null, 2));
  console.log(`Wrote docs/data.json from ${files.length} result file(s).`);
}

main();
