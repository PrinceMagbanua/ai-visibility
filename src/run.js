const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { tavily } = require("@tavily/core");

const brands = require("../config/brands.json").own;
const prompts = require("../config/prompts.json");
const trackedPages = require("../config/pages.json");

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

// Gemini's built-in Google Search grounding turned out to be billing-gated
// on the free tier (confirmed via src/diagnose-quota.js — plain text calls
// work, grounded/search-tool calls don't). So Tavily now does the actual web
// search (it has its own free tier), and Gemini only ever makes plain text
// calls — answer generation using Tavily's results as context, and the
// structured brand-mention analysis. Neither needs Google Search grounding.
const MODEL_CANDIDATES = (process.env.GEMINI_MODEL || "gemini-3.5-flash-lite,gemini-3.1-flash-lite")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
let activeModelIndex = 0;
const currentModel = () => MODEL_CANDIDATES[activeModelIndex];

const TAVILY_MAX_RESULTS = Number(process.env.TAVILY_MAX_RESULTS || 5);

// Stay comfortably under the free-tier RPM cap for the chosen Gemini model.
const CALL_DELAY_MS = Number(process.env.API_CALL_DELAY_MS || 5000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isQuotaError(err) {
  const message = err?.message || "";
  return err?.status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(message);
}

// makeRequest(model) builds the actual Gemini API call for a given model
// name. On a quota error, automatically switches to the next candidate
// model and retries the same call — no arbitrary backoff/retry loop, since
// a quota error won't clear up mid-run on the same model. Only throws
// (aborting the whole run) once every candidate model has been tried.
async function withModelFallback(makeRequest) {
  while (true) {
    const model = currentModel();
    try {
      const result = await makeRequest(model);
      await sleep(CALL_DELAY_MS);
      return result;
    } catch (err) {
      if (isQuotaError(err) && activeModelIndex < MODEL_CANDIDATES.length - 1) {
        activeModelIndex++;
        console.warn(`Quota hit on ${model} — switching to ${currentModel()} and retrying.`);
        continue;
      }
      throw err;
    }
  }
}

// Raw search-ranking track: what does Tavily itself return for this query,
// ranked, independent of any LLM. This is the "does this show up in AI-agent
// search results at all" signal.
async function tavilySearch(query) {
  const response = await tavilyClient.search(query, {
    maxResults: TAVILY_MAX_RESULTS,
    searchDepth: "basic",
  });

  return (response.results || []).map((r, i) => ({
    rank: i + 1,
    url: r.url,
    title: r.title,
    content: r.content,
    score: r.score,
  }));
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

// AI-answer track: Tavily supplies real search results as context, Gemini
// (plain text call, no tools — doesn't need Google's grounding) writes an
// answer citing them. This reproduces the "AI searches the web and answers"
// behaviour without depending on Gemini's billing-gated grounding.
async function getAnswer(prompt) {
  const tavilyResults = await tavilySearch(prompt);

  const context = tavilyResults
    .map((r) => `[${r.rank}] ${r.title}\nURL: ${r.url}\n${r.content}`)
    .join("\n\n");

  const response = await withModelFallback((model) =>
    geminiClient.models.generateContent({
      model,
      contents:
        `Answer this question as a helpful assistant would, using ONLY the search results below ` +
        `as your source of information. Cite sources by URL when you make a claim.\n\n` +
        `Question: ${prompt}\n\n` +
        `Search results:\n${context}`,
    }),
  );

  const text = response.text || "";
  const citations = tavilyResults.map((r) => ({ url: r.url, title: r.title }));

  return { text, citations, tavilyResults };
}

async function analyzeAnswer(prompt, answerText) {
  const brandList = brands.map((b) => `${b.code} (${b.name}, ${b.domain})`).join(", ");

  const response = await withModelFallback((model) =>
    geminiClient.models.generateContent({
      model,
      contents:
        `Here is an AI-generated answer to the question: "${prompt}"\n\n` +
        `---\n${answerText}\n---\n\n` +
        `Tracked brands: ${brandList}.\n` +
        `For each tracked brand, determine whether it is mentioned in the answer, ` +
        `roughly where (early/mid/late in the text, or not_mentioned), and the sentiment ` +
        `of the mention (positive/neutral/negative, or not_mentioned if absent). ` +
        `Also list any other company names mentioned that are not in the tracked brand list.`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: ANALYSIS_SCHEMA,
      },
    }),
  );

  return JSON.parse(response.text);
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

// Pure Tavily search-rank check for a tracked page — no LLM involved. This
// directly answers "does this specific URL show up when this question is
// searched", which is exactly what the original design wanted, and doesn't
// depend on Gemini at all.
async function checkPageCitation(page) {
  const results = await tavilySearch(page.question);
  const target = normalizeUrl(page.url);

  const domainMatches = results.filter((r) => normalizeUrl(r.url).hostname === target.hostname);
  const exactMatches = results.filter((r) => normalizeUrl(r.url).full === target.full);

  return {
    code: page.code,
    type: page.type,
    url: page.url,
    question: page.question,
    domain_cited: domainMatches.length > 0,
    exact_page_cited: exactMatches.length > 0,
    matched_results: domainMatches,
    total_results: results.length,
  };
}

// Errors that will fail identically on every subsequent call — no point
// burning through the rest of the prompts/pages once one of these hits.
function isFatalAccountError(err) {
  const message = err?.message || "";
  return (
    err?.status === 401 ||
    err?.status === 403 ||
    err?.status === 429 ||
    /API key not valid|PERMISSION_DENIED|RESOURCE_EXHAUSTED|exceeded your current quota|invalid api key|unauthorized|out of.*credits|insufficient credits|payment required/i.test(
      message,
    )
  );
}

async function main() {
  const promptResults = [];
  const pageCheckResults = [];
  const timestamp = new Date().toISOString();
  let aborted = false;

  console.log("=".repeat(60));
  console.log(`AI Visibility Check — ${timestamp}`);
  console.log(`Search provider: Tavily (@tavily/core)`);
  console.log(`Answer/analysis provider: Google Gemini (@google/genai)`);
  console.log(`Gemini model candidates (with automatic fallback): ${MODEL_CANDIDATES.join(" -> ")}`);
  console.log(`Call delay: ${CALL_DELAY_MS}ms`);
  console.log(`Prompts: ${prompts.length} | Tracked pages: ${trackedPages.length}`);
  console.log("=".repeat(60));

  for (const prompt of prompts) {
    if (aborted) break;
    console.log(`[tavily + ${currentModel()}] Running prompt: ${prompt}`);
    try {
      const { text, citations, tavilyResults } = await getAnswer(prompt);
      const analysis = await analyzeAnswer(prompt, text);
      promptResults.push({
        prompt,
        timestamp,
        model: currentModel(),
        tavily_results: tavilyResults,
        raw_response: text,
        citations,
        analysis,
      });
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
    console.log(`[tavily] Checking page citation: ${page.url}`);
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
  console.log("=".repeat(60));
  console.log(
    `Wrote ${promptResults.length} prompt results and ${pageCheckResults.length} page checks to ${outPath}`,
  );
  console.log(`Final Gemini model used: ${currentModel()} | Aborted early: ${aborted}`);
  console.log("=".repeat(60));

  if (aborted) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
