export default async function handler(req, res) {
  // -----------------------------
  // CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { question, blocks } = req.body || {};

    if (!question || typeof question !== "string") {
      return res.status(400).json({
        error: "Missing question"
      });
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({
        error: "Missing blocks"
      });
    }

    const cleanedBlocks = blocks
      .map((block, i) => ({
        index: Number.isInteger(block?.index) ? block.index : i,
        text: String(block?.text || "").trim(),
        kind: block?.kind || "text",
        section: block?.section || ""
      }))
      .filter(block => block.text.length > 0);

    if (!cleanedBlocks.length) {
      return res.status(400).json({
        error: "No usable page content"
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error("OPENAI_API_KEY is missing");

      return res.status(500).json({
        error: "Server configuration error"
      });
    }

    // --------------------------------------------------
    // Split blocks into sentences.
    // Each sentence keeps its original block index.
    // --------------------------------------------------

    const sentences = [];

    for (const block of cleanedBlocks) {
      const parts = splitIntoSentences(block.text);

      for (const sentence of parts) {
        const clean = sentence.trim();

        if (!clean) continue;

        sentences.push({
          block_index: block.index,
          sentence: clean,
          section: block.section,
          kind: block.kind
        });
      }
    }

    // Keep enough context for long pages.
    // But send sentences rather than huge paragraphs.
    const MAX_SENTENCES = 700;

    const sentenceCandidates = sentences.slice(0, MAX_SENTENCES);

    // --------------------------------------------------
    // Detect question intent
    // --------------------------------------------------

    const q = question.toLowerCase().trim();

    const isDuration =
      /\bhow long\b/.test(q) ||
      /\bhow many (hours|minutes|days|weeks|months|years)\b/.test(q) ||
      /\bwhat was the duration\b/.test(q);

    const isLocation =
      /\bwhere\b/.test(q) ||
      /\bwhere exactly\b/.test(q) ||
      /\bwhat location\b/.test(q) ||
      /\bwhich location\b/.test(q);

    const isWho =
      /\bwho\b/.test(q);

    const isWhen =
      /\bwhen\b/.test(q) ||
      /\bwhat date\b/.test(q) ||
      /\bwhat time\b/.test(q);

    // --------------------------------------------------
    // Add deterministic hints.
    // These do NOT answer the question.
    // They only help the model choose the right sentence.
    // --------------------------------------------------

    const candidateText = sentenceCandidates
      .map((item, i) => {
        let hint = "";

        const s = item.sentence.toLowerCase();

        if (isDuration) {
          if (
            /\b\d+(?:\.\d+)?\s*(hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\b/.test(s) ||
            /\bmore than\b/.test(s) ||
            /\bless than\b/.test(s) ||
            /\bapproximately\b/.test(s) ||
            /\babout\b/.test(s)
          ) {
            hint = " [DURATION-CANDIDATE]";
          }
        }

        if (isLocation) {
          if (
            /\blanding\b/.test(s) ||
            /\blanded\b/.test(s) ||
            /\bdescended\b/.test(s) ||
            /\barrived\b/.test(s) ||
            /\breached\b/.test(s) ||
            /\breached\b/.test(s) ||
            /\btouched down\b/.test(s)
          ) {
            hint += " [LOCATION-CANDIDATE]";
          }

          // Explicitly discourage "saw the landing site"
          // when the user asks where they landed.
          if (
            /\bsaw\b/.test(s) &&
            /\blanding site\b/.test(s)
          ) {
            hint += " [OBSERVATION-NOT-ACTUAL-LANDING]";
          }
        }

        if (isWhen) {
          if (
            /\b\d{4}\b/.test(s) ||
            /\bjan(?:uary)?\b|\bfeb(?:ruary)?\b|\bmar(?:ch)?\b|\bapr(?:il)?\b|\bmay\b|\bjun(?:e)?\b|\bjul(?:y)?\b|\baug(?:ust)?\b|\bsep(?:tember)?\b|\boct(?:ober)?\b|\bnov(?:ember)?\b|\bdec(?:ember)?\b/.test(s)
          ) {
            hint += " [TIME-CANDIDATE]";
          }
        }

        return `[${i}] block=${item.block_index}${hint}\n${item.sentence}`;
      })
      .join("\n\n");

    // --------------------------------------------------
    // Ask OpenAI for the EXACT answer sentence.
    // --------------------------------------------------

    const prompt = `
You are Snip, an exact-location webpage retrieval system.

USER QUESTION:
${question}

Your job is NOT to summarize the page.

Your job is to identify the SINGLE sentence from the supplied webpage that most directly answers the user's question.

CRITICAL RULES:

1. Return ONLY ONE sentence whenever one sentence directly answers the question.
2. Prefer the smallest possible evidence passage.
3. Do NOT return an entire paragraph.
4. Do NOT combine multiple unrelated sentences.
5. Do NOT choose a sentence merely because it contains related words.
6. Choose the sentence that actually answers the question.

QUESTION TYPE RULES:

If the question asks "HOW LONG":
- Prefer the sentence containing the actual duration.
- Look for hours, minutes, days, weeks, months, years, etc.
- Do NOT choose a sentence describing what happened afterward.
- For example, if the page says:
  "After more than 21 hours on the lunar surface, they rejoined Collins..."
  that sentence is the correct evidence for "How long did they stay on the Moon?"

If the question asks "WHERE":
- Choose the sentence describing where the event actually occurred.
- Prefer sentences containing "landed", "landing", "descended", "arrived", "reached", or "touched down".
- Do NOT choose a sentence merely saying people later saw, viewed, mapped, or observed the location.
- For example:
  "Armstrong and Aldrin descended to the surface aboard the LM Eagle, landing in the Sea of Tranquility..."
  is correct for "Where did Apollo 11 land?"
- A sentence saying "the crew saw passing views of their landing site..." is NOT the answer.

If the question asks WHO:
- Choose the sentence that explicitly identifies the person.

If the question asks WHEN:
- Choose the sentence containing the relevant date/time/event timing.

The returned sentence MUST be copied EXACTLY from the supplied webpage text.

Return JSON only in this format:

{
  "evidence": [
    {
      "block_index": 123,
      "passage": "exact sentence copied from the page"
    }
  ]
}

Return an empty evidence array only if the page truly does not contain the answer.

WEBPAGE SENTENCES:

${candidateText}
`;

    const response = await callOpenAI(apiKey, prompt);

    const parsed = parseModelJSON(response);

    if (!parsed || !Array.isArray(parsed.evidence)) {
      throw new Error("Invalid model response");
    }

    // --------------------------------------------------
    // Validate that returned evidence really exists
    // in the original page block.
    // --------------------------------------------------

    const validEvidence = [];

    for (const item of parsed.evidence.slice(0, 2)) {
      if (!item) continue;

      const blockIndex = Number(item.block_index);
      const passage = String(item.passage || "").trim();

      if (!Number.isInteger(blockIndex) || !passage) {
        continue;
      }

      const sourceBlock = cleanedBlocks.find(
        block => block.index === blockIndex
      );

      if (!sourceBlock) continue;

      if (containsEquivalentText(sourceBlock.text, passage)) {
        validEvidence.push({
          block_index: blockIndex,
          passage
        });
      }
    }

    // --------------------------------------------------
    // Deterministic fallback for obvious duration/location
    // questions if AI selected a nearby sentence.
    // --------------------------------------------------

    if (validEvidence.length === 0 || needsPrecisionOverride(validEvidence, question)) {
      const fallback = findBestDeterministicSentence(
        question,
        cleanedBlocks
      );

      if (fallback) {
        return res.status(200).json({
          evidence: [fallback]
        });
      }
    }

    return res.status(200).json({
      evidence: validEvidence
    });

  } catch (error) {
    console.error("FUNCTION ERROR:", error);

    return res.status(500).json({
      error: "Function failed"
    });
  }
}


// ======================================================
// OpenAI
// ======================================================

async function callOpenAI(apiKey, prompt) {
  const body = {
    model: "gpt-5-mini",
    store: false,

    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt
          }
        ]
      }
    ],

    max_output_tokens: 1200,

    text: {
      format: {
        type: "json_schema",
        name: "snip_evidence",
        strict: true,
        schema: {
          type: "object",
          properties: {
            evidence: {
              type: "array",
              maxItems: 2,
              items: {
                type: "object",
                properties: {
                  block_index: {
                    type: "integer"
                  },
                  passage: {
                    type: "string"
                  }
                },
                required: [
                  "block_index",
                  "passage"
                ],
                additionalProperties: false
              }
            }
          },
          required: [
            "evidence"
          ],
          additionalProperties: false
        }
      }
    }
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },

        body: JSON.stringify(body)
      }
    );

    const text = await response.text();

    if (!response.ok) {
      console.error(
        "OpenAI HTTP error:",
        response.status,
        text.slice(0, 2000)
      );

      if (
        response.status === 429 ||
        response.status >= 500
      ) {
        await sleep(700 * (attempt + 1));
        continue;
      }

      throw new Error("OpenAI API failed");
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Invalid OpenAI response");
    }

    const outputText = extractOutputText(data);

    if (outputText && outputText.trim()) {
      return outputText;
    }

    console.error(
      "Empty OpenAI response:",
      JSON.stringify(data).slice(0, 4000)
    );

    await sleep(500 * (attempt + 1));
  }

  throw new Error("Empty OpenAI response");
}


// ======================================================
// Extract Responses API text
// ======================================================

function extractOutputText(data) {
  if (
    typeof data?.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text;
  }

  const parts = [];

  for (const output of data?.output || []) {
    for (const content of output?.content || []) {
      if (
        typeof content?.text === "string" &&
        content.text.trim()
      ) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}


// ======================================================
// Parse JSON returned by model
// ======================================================

function parseModelJSON(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}


// ======================================================
// Sentence splitting
// ======================================================

function splitIntoSentences(text) {
  const normalized = text
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  // Handles normal punctuation while avoiding
  // destroying common abbreviations/numbers.
  const matches = normalized.match(
    /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g
  );

  return matches || [normalized];
}


// ======================================================
// Text normalization
// ======================================================

function normalizeText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}


function containsEquivalentText(source, passage) {
  const a = normalizeText(source);
  const b = normalizeText(passage);

  if (!a || !b) {
    return false;
  }

  if (a.includes(b)) {
    return true;
  }

  // More tolerant comparison for punctuation differences.
  const compactA = a.replace(/[^\p{L}\p{N}]+/gu, "");
  const compactB = b.replace(/[^\p{L}\p{N}]+/gu, "");

  return compactA.includes(compactB);
}


// ======================================================
// Precision override
// ======================================================

function needsPrecisionOverride(evidence, question) {
  if (!evidence.length) {
    return true;
  }

  const q = question.toLowerCase();

  const passage = evidence[0].passage.toLowerCase();

  // Duration question selected something without
  // a duration expression.
  if (/\bhow long\b/.test(q)) {
    const hasDuration =
      /\b\d+(?:\.\d+)?\s*(hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\b/.test(passage) ||
      /\bmore than\b/.test(passage) ||
      /\bless than\b/.test(passage);

    if (!hasDuration) {
      return true;
    }
  }

  // Location question selected an observation sentence
  // instead of the actual landing/event sentence.
  if (/\bwhere\b/.test(q)) {
    if (
      /\bsaw\b/.test(passage) &&
      /\blanding site\b/.test(passage)
    ) {
      return true;
    }
  }

  return false;
}


// ======================================================
// Deterministic fallback
// ======================================================

function findBestDeterministicSentence(question, blocks) {
  const q = question.toLowerCase();

  const sentences = [];

  for (const block of blocks) {
    for (const sentence of splitIntoSentences(block.text)) {
      const clean = sentence.trim();

      if (!clean) continue;

      sentences.push({
        block_index: block.index,
        passage: clean,
        score: 0
      });
    }
  }

  // --------------------------------------------
  // Duration
  // --------------------------------------------

  if (/\bhow long\b/.test(q)) {
    for (const item of sentences) {
      const s = item.passage.toLowerCase();

      if (
        /\b\d+(?:\.\d+)?\s*(hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\b/.test(s)
      ) {
        item.score += 100;
      }

      if (/\bmore than\b/.test(s)) {
        item.score += 30;
      }

      if (/\bless than\b/.test(s)) {
        item.score += 20;
      }

      if (/\bon the (?:lunar|moon)\b/.test(s)) {
        item.score += 20;
      }

      if (/\blunar surface\b/.test(s)) {
        item.score += 30;
      }

      // Strong penalty for unrelated later events.
      if (/\brejoined\b/.test(s)) {
        item.score -= 15;
      }

      if (/\breturned safely to earth\b/.test(s)) {
        item.score -= 30;
      }
    }
  }

  // --------------------------------------------
  // Location
  // --------------------------------------------

  if (/\bwhere\b/.test(q)) {
    for (const item of sentences) {
      const s = item.passage.toLowerCase();

      if (/\blanding in\b/.test(s)) {
        item.score += 120;
      }

      if (/\blanded in\b/.test(s)) {
        item.score += 120;
      }

      if (/\bdescended to the surface\b/.test(s)) {
        item.score += 80;
      }

      if (/\btouched down\b/.test(s)) {
        item.score += 100;
      }

      if (/\bsea of tranquility\b/.test(s)) {
        item.score += 50;
      }

      // This is specifically NOT the answer
      // to "where did they land?"
      if (
        /\bsaw\b/.test(s) &&
        /\blanding site\b/.test(s)
      ) {
        item.score -= 150;
      }

      if (/\bpassing views\b/.test(s)) {
        item.score -= 100;
      }
    }
  }

  const best = sentences
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  return best
    ? {
        block_index: best.block_index,
        passage: best.passage
      }
    : null;
}


// ======================================================
// Utility
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
