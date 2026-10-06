export default async function handler(req, res) {
  // =========================================================
  // CORS
  // =========================================================

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
    // =========================================================
    // API KEY
    // =========================================================

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY");

      return res.status(500).json({
        error: "Server configuration error"
      });
    }

    // =========================================================
    // REQUEST BODY
    // =========================================================

    const body = req.body || {};

    const question =
      typeof body.question === "string"
        ? body.question.trim()
        : "";

    const blocks =
      Array.isArray(body.blocks)
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

    // =========================================================
    // CLEAN INPUT
    // =========================================================

    const safeQuestion =
      question.slice(0, 1000);

    const safeBlocks = blocks
      .slice(0, 600)
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
      .filter(block =>
        block.text.trim()
      );

    if (!safeBlocks.length) {
      return res.status(400).json({
        error: "No usable page content was provided"
      });
    }

    // Keep request size manageable.
    let totalChars = 0;
    const limitedBlocks = [];

    for (const block of safeBlocks) {
      if (totalChars >= 180000) {
        break;
      }

      const remaining =
        180000 - totalChars;

      const text =
        block.text.slice(0, remaining);

      limitedBlocks.push({
        index: block.index,
        text
      });

      totalChars += text.length;
    }

    // =========================================================
    // NORMALIZE TEXT
    // =========================================================

    function normalize(text) {
      return String(text || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    // =========================================================
    // OPENAI
    // =========================================================

    async function callOpenAI(
      prompt,
      schema,
      name,
      attempt = 1
    ) {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(() => {
          controller.abort();
        }, 30000);

      try {
        const response =
          await fetch(
            "https://api.openai.com/v1/responses",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                "Authorization":
                  `Bearer ${apiKey}`
              },

              body: JSON.stringify({
                model: "gpt-5-mini",

                input: prompt,

                store: false,

                max_output_tokens: 1400,

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

        const raw =
          await response.text();

        // -----------------------------------------------------
        // API ERROR
        // -----------------------------------------------------

        if (!response.ok) {
          console.error(
            "OPENAI ERROR:",
            response.status,
            raw.slice(0, 4000)
          );

          // Retry transient errors.
          if (
            attempt < 2 &&
            (
              response.status === 429 ||
              response.status >= 500
            )
          ) {
            await new Promise(resolve =>
              setTimeout(resolve, 700)
            );

            return callOpenAI(
              prompt,
              schema,
              name,
              attempt + 1
            );
          }

          throw new Error(
            `OpenAI API error ${response.status}`
          );
        }

        // -----------------------------------------------------
        // PARSE JSON
        // -----------------------------------------------------

        let data;

        try {
          data = JSON.parse(raw);
        } catch (error) {
          console.error(
            "OPENAI INVALID JSON:",
            raw.slice(0, 4000)
          );

          if (attempt < 2) {
            await new Promise(resolve =>
              setTimeout(resolve, 500)
            );

            return callOpenAI(
              prompt,
              schema,
              name,
              attempt + 1
            );
          }

          throw new Error(
            "Invalid OpenAI response"
          );
        }

        // -----------------------------------------------------
        // PRIMARY OUTPUT PATH
        // -----------------------------------------------------

        if (
          typeof data.output_text === "string" &&
          data.output_text.trim()
        ) {
          try {
            return JSON.parse(
              data.output_text.trim()
            );
          } catch (error) {
            console.error(
              "OUTPUT_TEXT INVALID JSON:",
              data.output_text.slice(0, 4000)
            );
          }
        }

        // -----------------------------------------------------
        // OUTPUT ARRAY FALLBACK
        // -----------------------------------------------------

        const textParts = [];

        if (Array.isArray(data.output)) {
          for (const item of data.output) {
            if (
              !item ||
              !Array.isArray(item.content)
            ) {
              continue;
            }

            for (const content of item.content) {
              if (
                content &&
                content.type === "output_text" &&
                typeof content.text === "string"
              ) {
                textParts.push(
                  content.text
                );
              }
            }
          }
        }

        const extractedText =
          textParts.join("").trim();

        if (extractedText) {
          try {
            return JSON.parse(
              extractedText
            );
          } catch (error) {
            console.error(
              "EXTRACTED OUTPUT INVALID JSON:",
              extractedText.slice(0, 4000)
            );
          }
        }

        // -----------------------------------------------------
        // EMPTY OUTPUT
        // -----------------------------------------------------

        console.error(
          "OPENAI EMPTY OUTPUT:",
          JSON.stringify(data).slice(0, 6000)
        );

        // Retry once.
        if (attempt < 2) {
          await new Promise(resolve =>
            setTimeout(resolve, 700)
          );

          return callOpenAI(
            prompt,
            schema,
            name,
            attempt + 1
          );
        }

        throw new Error(
          "Empty OpenAI response"
        );

      } catch (error) {
        if (
          error &&
          error.name === "AbortError"
        ) {
          console.error(
            "OPENAI TIMEOUT"
          );

          if (attempt < 2) {
            return callOpenAI(
              prompt,
              schema,
              name,
              attempt + 1
            );
          }

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
    // PASS 1 — SEMANTIC RETRIEVAL
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
You are Snip's webpage retrieval engine.

Your job is to find where on the ORIGINAL WEBPAGE the answer
to the user's question is located.

USER QUESTION:

"${safeQuestion}"

IMPORTANT:

The user wants the information that DIRECTLY answers the question.

Do not simply select passages that mention the same topic.

For example:

Question:
"When did Apollo 11 launch?"

GOOD:
"Saturn V AS-506 launched Apollo 11 on July 16, 1969..."

BAD:
"Full shutdown of the first-stage engines occurred about
2 minutes and 42 seconds into the mission..."

The second passage is related to the launch, but it does NOT
directly answer when Apollo 11 launched.

Another example:

Question:
"Where did Apollo 11 land?"

GOOD:
"landing in the Sea of Tranquility..."

BAD:
"a three-day transit..."

Select up to 12 blocks that could contain the DIRECT answer.

Rank the most likely blocks first.

Understand the meaning of the question rather than relying
only on exact keyword matches.

Return only block indexes and short reasons.

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
                block =>
                  block.index === index
              )
            )
            .slice(0, 12)
        : [];

    // =========================================================
    // CANDIDATE BLOCKS
    // =========================================================

    let candidateBlocks =
      limitedBlocks.filter(block =>
        selectedIndexes.includes(
          block.index
        )
      );

    // Fallback if retrieval returns nothing.
    if (!candidateBlocks.length) {
      candidateBlocks =
        limitedBlocks.slice(0, 12);
    }

    // =========================================================
    // PASS 2 — PRECISION LOCATOR
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

USER QUESTION:

"${safeQuestion}"

Your job is to select the exact passage from the original
webpage that BEST answers the question.

This is NOT a summarization task.

The user will be taken directly to the passage you select.

Therefore accuracy is critical.

RULES:

1. Choose the MOST DIRECT answer.

2. Do not choose a passage merely because it is related
   to the subject.

3. Prefer the sentence that actually contains the answer.

4. If the question asks WHEN, select the passage containing
   the relevant date/time.

5. If the question asks WHERE, select the passage containing
   the relevant location.

6. If the question asks WHO, select the passage identifying
   the person or people.

7. If the question asks HOW MANY, select the passage
   containing the number.

8. If the question asks WHY, select the passage explaining
   the cause or reason.

9. Copy the selected passage VERBATIM from the webpage.

10. Do not rewrite it.

11. Do not summarize it.

12. Do not invent text.

13. Keep the selected passage as short as possible while
    preserving the answer.

14. You may return up to 2 passages only when two passages
    are genuinely necessary.

15. If the page does not contain the answer, return an
    empty evidence array.

IMPORTANT:

For a question such as:

"When did Apollo 11 launch?"

Prefer:

"Saturn V AS-506 launched Apollo 11 on July 16, 1969..."

over a later sentence about engine shutdown.

For:

"Where did Apollo 11 land?"

Prefer the sentence containing:

"Sea of Tranquility"

over a sentence merely describing the trip to the Moon.

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
          b =>
            b.index ===
            item.block_index
        );

      if (!block) {
        continue;
      }

      const original =
        block.text;

      const exactMatch =
        original.includes(
          item.text
        );

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
    // FINAL RESPONSE
    // =========================================================

    return res.status(200).json({
      evidence:
        validEvidence.slice(0, 2)
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
