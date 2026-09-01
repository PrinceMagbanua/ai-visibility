const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const brands = require("../config/brands.json").own;
const prompts = require("../config/prompts.json");
const trackedPages = require("../config/pages.json");

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// The plain "Flash" free tier is only 5 RPM / 20 requests-per-day — far too
// low for a ~46-call run. "Flash Lite" gets a much higher free daily quota
// (15 RPM / 500 RPD as of writing) — check current numbers per model at
// https://aistudio.google.com/rate-limit before changing this.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// Stay comfortably under the free-tier RPM cap for the chosen model.
const CALL_DELAY_MS = Number(process.env.API_CALL_DELAY_MS || 5000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRateLimit(fn) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      await sleep(CALL_DELAY_MS);
      return result;
    } catch (err) {
      const message = err?.message || "";
      const isRateLimit = err?.status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(message);
      if (!isRateLimit || attempt === maxAttempts) throw err;
      const backoff = CALL_DELAY_MS * 2 ** attempt;
      console.warn(`Rate limited (attempt ${attempt}/${maxAttempts}): ${message}`);
      console.warn(`Waiting ${backoff}ms before retry...`);
      await sleep(backoff);
    }
  }
}

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    brands_mentioned: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string", description: "Brand code, e.g. EMT, LHC, TMD" },
          mentioned: { type: "boolean" },
          position: {
            type: "string",
            enum: ["early", "mid", "late", "not_mentioned"],
            description: "Where in the answer the brand first appears",
          },
          sentiment: {
            type: "string",
            enum: ["positive", "neutral", "negative", "not_mentioned"],
          },
        },
        required: ["code", "mentioned", "position", "sentiment"],
      },
    },
    competitors_mentioned: {
      type: "array",
      items: { type: "string" },
      description: "Names of other companies mentioned that are not in the tracked brand list",
    },
  },
  required: ["brands_mentioned", "competitors_mentioned"],
};

async function getAnswer(prompt) {
  const interaction = await withRateLimit(() =>
    client.interactions.create({
      model: MODEL,
      input: prompt,
      tools: [{ type: "google_search" }],
    }),
  );

  const text = interaction.output_text || "";
  const citations = [];

  for (const step of interaction.steps || []) {
    if (step.type !== "model_output") continue;
    for (const contentBlock of step.content || []) {
      if (contentBlock.type !== "text" || !contentBlock.annotations) continue;
      for (const annotation of contentBlock.annotations) {
        if (annotation.type === "url_citation") {
          citations.push({ url: annotation.url, title: annotation.title });
        }
      }
    }
  }

  return { text, citations };
}

async function analyzeAnswer(prompt, answerText) {
  const brandList = brands.map((b) => `${b.code} (${b.name}, ${b.domain})`).join(", ");

  const interaction = await withRateLimit(() =>
    client.interactions.create({
      model: MODEL,
      input:
        `Here is an AI-generated answer to the question: "${prompt}"\n\n` +
        `---\n${answerText}\n---\n\n` +
        `Tracked brands: ${brandList}.\n` +
        `For each tracked brand, determine whether it is mentioned in the answer, ` +
        `roughly where (early/mid/late in the text, or not_mentioned), and the sentiment ` +
        `of the mention (positive/neutral/negative, or not_mentioned if absent). ` +
        `Also list any other company names mentioned that are not in the tracked brand list.`,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: ANALYSIS_SCHEMA,
      },
    }),
  );

  return JSON.parse(interaction.output_text);
}

function normalizeUrl(u) {
  try {
    const withProtocol = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/$/, "");
    return { hostname: hostname.toLowerCase(), full: (hostname + pathname).toLowerCase() };
  } catch {
    return { hostname: u.toLowerCase(), full: u.toLowerCase() };
  }
}

async function checkPageCitation(page) {
  const { citations } = await getAnswer(page.question);
  const target = normalizeUrl(page.url);

  const domainMatches = citations.filter((c) => normalizeUrl(c.url).hostname === target.hostname);
  const exactMatches = citations.filter((c) => normalizeUrl(c.url).full === target.full);

  return {
    code: page.code,
    type: page.type,
    url: page.url,
    question: page.question,
    domain_cited: domainMatches.length > 0,
    exact_page_cited: exactMatches.length > 0,
    matched_citations: domainMatches,
    total_citations: citations.length,
  };
}

// Errors that will fail identically on every subsequent call — no point
// burning through the rest of the prompts/pages once one of these hits.
function isFatalAccountError(err) {
  const message = err?.message || "";
  return err?.status === 401 || err?.status === 403 || /API key not valid|PERMISSION_DENIED/i.test(message);
}

async function main() {
  const promptResults = [];
  const pageCheckResults = [];
  const timestamp = new Date().toISOString();
  let aborted = false;

  for (const prompt of prompts) {
    if (aborted) break;
    console.log(`Running prompt: ${prompt}`);
    try {
      const { text, citations } = await getAnswer(prompt);
      const analysis = await analyzeAnswer(prompt, text);
      promptResults.push({ prompt, timestamp, raw_response: text, citations, analysis });
    } catch (err) {
      console.error(`Failed on prompt "${prompt}":`, err.message);
      promptResults.push({ prompt, timestamp, error: err.message });
      if (isFatalAccountError(err)) {
        console.error("Fatal account error — aborting the rest of this run.");
        aborted = true;
      }
    }
  }

  for (const page of trackedPages) {
    if (aborted) break;
    console.log(`Checking page citation: ${page.url}`);
    try {
      const result = await checkPageCitation(page);
      pageCheckResults.push({ ...result, timestamp });
    } catch (err) {
      console.error(`Failed on page "${page.url}":`, err.message);
      pageCheckResults.push({ code: page.code, type: page.type, url: page.url, timestamp, error: err.message });
      if (isFatalAccountError(err)) {
        console.error("Fatal account error — aborting the rest of this run.");
        aborted = true;
      }
    }
  }

  const resultsDir = path.join(__dirname, "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const dateStr = timestamp.slice(0, 10);
  const outPath = path.join(resultsDir, `${dateStr}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ timestamp, prompts: promptResults, page_checks: pageCheckResults, aborted }, null, 2),
  );
  console.log(
    `Wrote ${promptResults.length} prompt results and ${pageCheckResults.length} page checks to ${outPath}`,
  );

  if (aborted) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
