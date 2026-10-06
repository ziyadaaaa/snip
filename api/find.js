export default async function handler(req, res) {
  // -----------------------------
  // CORS
  // -----------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    // -----------------------------
    // ENV
    // -----------------------------
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY");

      return res.status(500).json({
        error: "Server configuration error"
      });
    }

    // -----------------------------
    // BODY
    // -----------------------------
    const body = req.body || {};

    const question =
      typeof body.question === "string"
        ? body.question.trim()
        : "";

    const blocks = Array.isArray(body.blocks)
      ? body.blocks
      : [];

    if (!question) {
      return res.status(400).json({
        error: "Question is required"
      });
    }

    if (!blocks.length) {
      return res.status(400).json({
        error: "No page content was provided"
      });
    }

    // -----------------------------
    // LIMIT INPUT
    // -----------------------------
    const safeQuestion = question.slice(0, 1000);

    const safeBlocks = blocks
      .slice(0, 500)
      .map((block, index) => {
        if (typeof block === "string") {
          return {
            index,
            text: block.slice(0, 4000)
          };
        }

        return {
          index:
            typeof block.index === "number"
              ? block.index
              : index,

          text:
            typeof block.text === "string"
              ? block.text.slice(0, 4000)
              : ""
        };
      })
      .filter(block => block.text.trim());

    if (!safeBlocks.length) {
      return res.status(400).json({
        error: "No usable page content was provided"
      });
    }

    // Keep total request size reasonable
    let totalChars = 0;
    const limitedBlocks = [];

    for (const block of safeBlocks) {
      if (totalChars >= 180000) break;

      const remaining = 180000 - totalChars;

      const text = block.text.slice(0, remaining);

      limitedBlocks.push({
        index: block.index,
        text
      });

      totalChars += text.length;
    }

    // -----------------------------
    // OPENAI CALL
    // -----------------------------
    async function callOpenAI(prompt, schema, name) {
      const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 30000);

      try {
        const response = await fetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },

            body: JSON.stringify({
              model: "gpt-5-mini",

              input: prompt,

              store: false,

              max_output_tokens: 1200,

              text: {
                format: {
                  type: "json_schema",
                  name,
                  strict: true,
                  schema
                }
              }
            }),

            signal: controller.signal
          }
        );

        const raw = await response.text();

        // -----------------------------
        // OPENAI ERROR
        // -----------------------------
        if (!response.ok) {
          console.error(
            "OPENAI ERROR:",
            response.status,
            raw.slice(0, 4000)
          );

          throw new Error(
            `OpenAI API error ${response.status}`
          );
        }

        // -----------------------------
        // PARSE RESPONSE
        // -----------------------------
        let data;

        try {
          data = JSON.parse(raw);
        } catch (error) {
          console.error(
            "OPENAI INVALID JSON:",
            raw.slice(0, 4000)
          );

          throw new Error(
            "Invalid OpenAI response"
          );
        }

        // -----------------------------
        // METHOD 1:
        // output_text
        // -----------------------------
        if (
          typeof data.output_text === "string" &&
          data.output_text.trim()
        ) {
          return JSON.parse(
            data.output_text.trim()
          );
        }

        // -----------------------------
        // METHOD 2:
        // output -> message -> content
        // -----------------------------
        const textParts = [];

        if (Array.isArray(data.output)) {
          for (const item of data.output) {
            if (!Array.isArray(item.content)) {
              continue;
            }

            for (const content of item.content) {
              if (
                content &&
                content.type === "output_text" &&
                typeof content.text === "string"
              ) {
                textParts.push(content.text);
              }
            }
          }
        }

        const extractedText =
          textParts.join("").trim();

        if (extractedText) {
          try {
            return JSON.parse(extractedText);
          } catch (error) {
            console.error(
              "OPENAI OUTPUT WAS NOT VALID JSON:",
              extractedText.slice(0, 4000)
            );

            throw new Error(
              "OpenAI returned invalid structured output"
            );
          }
        }

        // -----------------------------
        // NOTHING FOUND
        // -----------------------------
        console.error(
          "OPENAI EMPTY OUTPUT:",
          JSON.stringify(data).slice(0, 6000)
        );

        throw new Error(
          "Empty OpenAI response"
        );

      } catch (error) {
        if (error.name === "AbortError") {
          console.error(
            "OPENAI TIMEOUT"
          );

          throw new Error(
            "OpenAI request timed out"
          );
        }

        throw error;

      } finally {
        clearTimeout(timeout);
      }
    }

    // =========================================================
    // PASS 1 — FIND RELEVANT BLOCKS
    // =========================================================

    const retrievalSchema = {
      type: "object",

      properties: {
        relevant_blocks: {
          type: "array",

          items: {
            type: "object",

            properties: {
              index: {
                type: "integer"
              },

              reason: {
                type: "string"
              }
            },

            required: [
              "index",
              "reason"
            ],

            additionalProperties: false
          }
        }
      },

      required: [
        "relevant_blocks"
      ],

      additionalProperties: false
    };

    const retrievalPrompt = `
You are the retrieval engine for Snip.

Snip finds the exact part of a webpage that answers a user's question.

The user asked:

"${safeQuestion}"

Below are blocks extracted from the webpage.

Your job is to identify the blocks most likely to contain the answer.

IMPORTANT:

- Understand the meaning of the question.
- Do NOT require the page to use the exact wording of the question.
- Prefer blocks containing the actual answer.
- If a heading contains useful information, it can be selected.
- Select up to 8 relevant blocks.
- Return only block indexes and short reasons.

PAGE BLOCKS:

${JSON.stringify(limitedBlocks)}
`;

    const retrieval =
      await callOpenAI(
        retrievalPrompt,
        retrievalSchema,
        "snip_retrieval"
      );

    const selectedIndexes =
      Array.isArray(
        retrieval.relevant_blocks
      )
        ? retrieval.relevant_blocks
            .map(item => item.index)
            .filter(index =>
              limitedBlocks.some(
                block => block.index === index
              )
            )
            .slice(0, 8)
        : [];

    // -----------------------------
    // FALLBACK
    // -----------------------------
    let candidateBlocks =
      limitedBlocks.filter(block =>
        selectedIndexes.includes(block.index)
      );

    if (!candidateBlocks.length) {
      candidateBlocks =
        limitedBlocks.slice(0, 8);
    }

    // =========================================================
    // PASS 2 — EXACT LOCATION
    // =========================================================

    const locatorSchema = {
      type: "object",

      properties: {
        evidence: {
          type: "array",

          items: {
            type: "object",

            properties: {
              block_index: {
                type: "integer"
              },

              text: {
                type: "string"
              }
            },

            required: [
              "block_index",
              "text"
            ],

            additionalProperties: false
          }
        }
      },

      required: [
        "evidence"
      ],

      additionalProperties: false
    };

    const locatorPrompt = `
You are Snip's precision locator.

User question:

"${safeQuestion}"

You have candidate blocks from the original webpage.

Your task is to identify the smallest useful passage that answers the question.

Rules:

1. Choose up to 2 passages.
2. The passage MUST come from the provided webpage blocks.
3. Copy the passage VERBATIM.
4. Do not rewrite it.
5. Do not summarize it.
6. Do not invent text.
7. Prefer a short passage that directly answers the question.
8. The passage can be a sentence, several sentences, or a heading plus relevant text.
9. If the answer is represented by a heading or metadata on the page, that can be selected.
10. Return an empty array if there is genuinely no relevant information.

CANDIDATE BLOCKS:

${JSON.stringify(candidateBlocks)}
`;

    const located =
      await callOpenAI(
        locatorPrompt,
        locatorSchema,
        "snip_locator"
      );

    // =========================================================
    // VALIDATION
    // =========================================================

    const evidence =
      Array.isArray(located.evidence)
        ? located.evidence
        : [];

    function normalize(text) {
      return String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    const validEvidence = [];

    for (const item of evidence) {
      if (
        !item ||
        typeof item.block_index !== "number" ||
        typeof item.text !== "string"
      ) {
        continue;
      }

      const block =
        limitedBlocks.find(
          b => b.index === item.block_index
        );

      if (!block) {
        continue;
      }

      const original =
        block.text;

      const exactMatch =
        original.includes(item.text);

      const normalizedOriginal =
        normalize(original);

      const normalizedEvidence =
        normalize(item.text);

      const normalizedMatch =
        normalizedOriginal.includes(
          normalizedEvidence
        );

      if (
        exactMatch ||
        normalizedMatch
      ) {
        validEvidence.push({
          block_index:
            item.block_index,

          text:
            item.text
        });
      }
    }

    // =========================================================
    // RESPONSE
    // =========================================================

    return res.status(200).json({
      evidence: validEvidence.slice(0, 2)
    });

  } catch (error) {
    console.error(
      "FUNCTION ERROR:",
      error
    );

    return res.status(500).json({
      error: "Function failed"
    });
  }
}
