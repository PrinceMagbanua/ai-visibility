const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const brands = require("../config/brands.json").own;
const prompts = require("../config/prompts.json");

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

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
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages: [{ role: "user", content: prompt }],
  });

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

  const response = await client.messages.create({
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
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

async function main() {
  const results = [];
  const timestamp = new Date().toISOString();

  for (const prompt of prompts) {
    console.log(`Running prompt: ${prompt}`);
    try {
      const { text, citations } = await getAnswer(prompt);
      const analysis = await analyzeAnswer(prompt, text);
      results.push({ prompt, timestamp, raw_response: text, citations, analysis });
    } catch (err) {
      console.error(`Failed on prompt "${prompt}":`, err.message);
      results.push({ prompt, timestamp, error: err.message });
    }
  }

  const resultsDir = path.join(__dirname, "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const dateStr = timestamp.slice(0, 10);
  const outPath = path.join(resultsDir, `${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Wrote ${results.length} results to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
