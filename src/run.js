const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const brands = require("../config/brands.json").own;
const prompts = require("../config/prompts.json");
const trackedPages = require("../config/pages.json");

const client = new Anthropic({
  // reads ANTHROPIC_API_KEY from env
  defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
    ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
    : undefined,
});

// Evaluation-tier keys have very low rate limits — space requests out and
// retry on 429 instead of hammering the API.
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
      const isRateLimit = err?.status === 429 || err?.error?.error?.type === "rate_limit_error";
      if (!isRateLimit || attempt === maxAttempts) throw err;
      const backoff = CALL_DELAY_MS * 2 ** attempt;
      console.warn(`Rate limited (attempt ${attempt}/${maxAttempts}), waiting ${backoff}ms...`);
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
        additionalProperties: false,
      },
    },
    competitors_mentioned: {
      type: "array",
      items: { type: "string" },
      description: "Names of other companies mentioned that are not in the tracked brand list",
    },
  },
  required: ["brands_mentioned", "competitors_mentioned"],
  additionalProperties: false,
};

async function getAnswer(prompt) {
  const response = await withRateLimit(() =>
    client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: prompt }],
    }),
  );

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const citations = [];
  for (const block of response.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.url) citations.push({ url: result.url, title: result.title });
      }
    }
  }

  return { text, citations };
}

async function analyzeAnswer(prompt, answerText) {
  const brandList = brands.map((b) => `${b.code} (${b.name}, ${b.domain})`).join(", ");

  const response = await withRateLimit(() =>
    client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      messages: [
        {
          role: "user",
          content:
            `Here is an AI-generated answer to the question: "${prompt}"\n\n` +
            `---\n${answerText}\n---\n\n` +
            `Tracked brands: ${brandList}.\n` +
            `For each tracked brand, determine whether it is mentioned in the answer, ` +
            `roughly where (early/mid/late in the text, or not_mentioned), and the sentiment ` +
            `of the mention (positive/neutral/negative, or not_mentioned if absent). ` +
            `Also list any other company names mentioned that are not in the tracked brand list.`,
        },
      ],
    }),
  );

  const textBlock = response.content.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
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

async function main() {
  const promptResults = [];
  const pageCheckResults = [];
  const timestamp = new Date().toISOString();

  for (const prompt of prompts) {
    console.log(`Running prompt: ${prompt}`);
    try {
      const { text, citations } = await getAnswer(prompt);
      const analysis = await analyzeAnswer(prompt, text);
      promptResults.push({ prompt, timestamp, raw_response: text, citations, analysis });
    } catch (err) {
      console.error(`Failed on prompt "${prompt}":`, err.message);
      promptResults.push({ prompt, timestamp, error: err.message });
    }
  }

  for (const page of trackedPages) {
    console.log(`Checking page citation: ${page.url}`);
    try {
      const result = await checkPageCitation(page);
      pageCheckResults.push({ ...result, timestamp });
    } catch (err) {
      console.error(`Failed on page "${page.url}":`, err.message);
      pageCheckResults.push({ code: page.code, type: page.type, url: page.url, timestamp, error: err.message });
    }
  }

  const resultsDir = path.join(__dirname, "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const dateStr = timestamp.slice(0, 10);
  const outPath = path.join(resultsDir, `${dateStr}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ timestamp, prompts: promptResults, page_checks: pageCheckResults }, null, 2),
  );
  console.log(
    `Wrote ${promptResults.length} prompt results and ${pageCheckResults.length} page checks to ${outPath}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
