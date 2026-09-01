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

// Mirrors the exact call shape run.js uses in getAnswer() — this is the
// thing that actually matters, since the real script always attaches the
// search tool. A model can pass a bare text call and still fail here if
// Google Search grounding has its own separate quota/eligibility gate.
async function testGrounded(model) {
  try {
    const response = await client.models.generateContent({
      model,
      contents: "What is the capital of France? Use search to confirm.",
      config: { tools: [{ googleSearch: {} }] },
    });
    const usedSearch = !!response.candidates?.[0]?.groundingMetadata;
    return { model, ok: true, text: response.text?.trim()?.slice(0, 60), usedSearch };
  } catch (err) {
    return { model, ok: false, error: err.message };
  }
}

async function testPlain(model) {
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
  const plainResults = [];
  const groundedResults = [];

  console.log("--- Plain text calls (no search tool) ---");
  for (const model of MODELS_TO_TEST) {
    process.stdout.write(`  ${model} ... `);
    const result = await testPlain(model);
    plainResults.push(result);
    console.log(result.ok ? `OK (replied: "${result.text}")` : `FAILED: ${result.error}`);
    await sleep(3000);
  }

  console.log("\n--- Grounded calls WITH Google Search tool (matches run.js) ---");
  for (const model of MODELS_TO_TEST) {
    process.stdout.write(`  ${model} ... `);
    const result = await testGrounded(model);
    groundedResults.push(result);
    console.log(
      result.ok
        ? `OK (grounding metadata present: ${result.usedSearch}, replied: "${result.text}")`
        : `FAILED: ${result.error}`,
    );
    await sleep(3000);
  }

  console.log("\n=== Summary ===");
  const plainWorking = plainResults.filter((r) => r.ok).map((r) => r.model);
  const groundedWorking = groundedResults.filter((r) => r.ok).map((r) => r.model);
  console.log(`Plain text working: ${plainWorking.join(", ") || "none"}`);
  console.log(`Grounded (search tool) working: ${groundedWorking.join(", ") || "none"}`);

  if (groundedWorking.length === 0 && plainWorking.length > 0) {
    console.log(
      "\nPlain text works but grounded search calls don't for every model tested — " +
        "this points to Google Search grounding specifically being unavailable/quota-gated " +
        "on this key, separate from the model's own text-generation quota.",
    );
  } else if (groundedWorking.length === 0) {
    console.log(
      "\nNothing worked at all, plain or grounded — this points to an account/project-level " +
        "issue (billing not linked, API not enabled, or a key-wide block).",
    );
  } else {
    console.log(`\nUse GEMINI_MODEL=${groundedWorking[0]} — confirmed working with search grounding right now.`);
  }
}

main();
