const { GoogleGenAI } = require("@google/genai");

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// A spread of "Text-out models" free-tier candidates, cheapest/highest-quota
// first based on the aistudio.google.com/rate-limit dashboard.
const MODELS_TO_TEST = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testModel(model) {
  try {
    const response = await client.models.generateContent({
      model,
      contents: "Reply with exactly the word OK.",
    });
    return { model, ok: true, text: response.text?.trim() };
  } catch (err) {
    return { model, ok: false, error: err.message };
  }
}

async function main() {
  console.log(`Testing ${MODELS_TO_TEST.length} model(s) against this API key...\n`);
  const results = [];

  for (const model of MODELS_TO_TEST) {
    process.stdout.write(`  ${model} ... `);
    const result = await testModel(model);
    results.push(result);
    console.log(result.ok ? `OK (replied: "${result.text}")` : `FAILED: ${result.error}`);
    await sleep(3000);
  }

  console.log("\n=== Summary ===");
  const working = results.filter((r) => r.ok);
  const failing = results.filter((r) => !r.ok);
  console.log(`Working: ${working.map((r) => r.model).join(", ") || "none"}`);
  console.log(`Failing: ${failing.map((r) => r.model).join(", ") || "none"}`);

  if (working.length === 0) {
    console.log(
      "\nNo tested model worked at all — this points to an account/project-level issue " +
        "(billing not linked, API not enabled, or a key-wide block), not a single model's quota.",
    );
  } else {
    console.log(`\nUse GEMINI_MODEL=${working[0].model} — it's confirmed working right now.`);
  }
}

main();
