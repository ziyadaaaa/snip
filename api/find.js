export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing"
      });
    }

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
        error: "No readable page content was found"
      });
    }

    /*
     * Clean and normalize the blocks coming from the extension.
     */
    const safeBlocks = [];
    let totalChars = 0;

    for (const block of blocks) {
      if (
        !block ||
        typeof block.id !== "string" ||
        typeof block.text !== "string"
      ) {
        continue;
      }

      const id = block.id.slice(0, 100);
      const text = block.text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1800);

      if (!id || text.length < 10) continue;

      /*
       * Allow large pages, but prevent accidentally enormous
       * requests from breaking the function.
       */
      if (totalChars + text.length > 240000) {
        break;
      }

      safeBlocks.push({
        id,
        text
      });

      totalChars += text.length;
    }

    if (!safeBlocks.length) {
      return res.status(400).json({
        error: "No usable page content was found"
      });
    }

    /*
     * ---------------------------------------------------------
     * STAGE 1
     *
     * Split the page into manageable chunks and ask the model
     * which passages are semantically relevant.
     * ---------------------------------------------------------
     */

    const CHUNK_SIZE = 30000;

    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const block of safeBlocks) {
      if (
        currentChunk.length &&
        currentLength + block.text.length > CHUNK_SIZE
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLength = 0;
      }

      currentChunk.push(block);
      currentLength += block.text.length;
    }

    if (currentChunk.length) {
      chunks.push(currentChunk);
    }

    const candidateSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        candidates: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              block_id: {
                type: "string"
              },
              reason: {
                type: "string"
              }
            },
            required: [
              "block_id",
              "reason"
            ]
          }
        }
      },
      required: [
        "candidates"
      ]
    };

    async function askOpenAI({
      prompt,
      schema,
      name,
      maxOutputTokens
    }) {
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
            store: false,
            input: prompt,
            max_output_tokens: maxOutputTokens,
            text: {
              format: {
                type: "json_schema",
                name,
                strict: true,
                schema
              }
            }
          })
        }
      );

      const raw = await response.text();

      if (!response.ok) {
        console.error(
          "OpenAI error:",
          raw.slice(0, 1500)
        );

        throw new Error("OpenAI request failed");
      }

      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("Invalid OpenAI response");
      }

      let outputText = "";

      if (
        typeof data.output_text === "string" &&
        data.output_text.trim()
      ) {
        outputText = data.output_text.trim();
      }

      if (!outputText && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (!Array.isArray(item.content)) continue;

          for (const content of item.content) {
            if (
              content?.type === "output_text" &&
              typeof content.text === "string"
            ) {
              outputText += content.text;
            }
          }
        }

        outputText = outputText.trim();
      }

      if (!outputText) {
        throw new Error("AI returned no usable output");
      }

      try {
        return JSON.parse(outputText);
      } catch {
        console.error(
          "AI returned invalid JSON:",
          outputText.slice(0, 1000)
        );

        throw new Error("Invalid AI JSON response");
      }
    }

    async function searchChunk(chunk) {
      const source = chunk
        .map(
          block =>
            `[${block.id}]\n${block.text}`
        )
        .join("\n\n");

      const prompt = `
You are the retrieval engine for Snip.

Snip does NOT answer the user's question.

Snip finds the exact part of the webpage that contains the answer.

USER QUESTION:
${question}

PAGE CONTENT:

${source}

TASK:

Find up to 5 blocks that are most likely to contain information needed to answer the user's question.

The user's wording may be completely different from the wording on the page.

For example:

User:
"How did Apollo 11 return to Earth?"

Page:
"The crew returned safely to Earth on July 24, splashing down in the Pacific Ocean."

These are semantically related.

Important rules:

- Search by MEANING, not exact wording.
- A candidate can be relevant even if it does not contain the same words as the question.
- Only return block IDs that actually exist above.
- Do not invent block IDs.
- Do not answer the question.
- Do not quote text.
- If the section contains no useful information, return an empty candidates array.

Return the strongest candidates.
`;

      try {
        const result = await askOpenAI({
          prompt,
          schema: candidateSchema,
          name: "snip_candidates",
          maxOutputTokens: 700
        });

        return Array.isArray(result?.candidates)
          ? result.candidates
          : [];
      } catch (error) {
        console.error(
          "Chunk search failed:",
          error.message
        );

        return [];
      }
    }

    /*
     * Search all page chunks concurrently.
     */
    const chunkResults = await Promise.all(
      chunks.map(searchChunk)
    );

    /*
     * Build a unique set of candidate block IDs.
     */
    const candidateIds = [];

    for (const result of chunkResults) {
      for (const candidate of result) {
        if (
          !candidate ||
          typeof candidate.block_id !== "string"
        ) {
          continue;
        }

        if (
          !candidateIds.includes(candidate.block_id)
        ) {
          candidateIds.push(candidate.block_id);
        }
      }
    }

    /*
     * Limit the final selection to the strongest set of blocks.
     */
    const candidateBlocks = candidateIds
      .map(id =>
        safeBlocks.find(
          block => block.id === id
        )
      )
      .filter(Boolean)
      .slice(0, 20);

    if (!candidateBlocks.length) {
      return res.status(200).json({
        evidence: []
      });
    }

    /*
     * ---------------------------------------------------------
     * STAGE 2
     *
     * Now that we have semantically relevant sections, ask the
     * model to select the EXACT original wording.
     * ---------------------------------------------------------
     */

    const finalSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        evidence: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              block_id: {
                type: "string"
              },
              text: {
                type: "string"
              }
            },
            required: [
              "block_id",
              "text"
            ]
          }
        }
      },
      required: [
        "evidence"
      ]
    };

    const finalSource = candidateBlocks
      .map(
        block =>
          `[${block.id}]\n${block.text}`
      )
      .join("\n\n");

    const finalPrompt = `
You are the final exact-location selector for Snip.

USER QUESTION:
${question}

CANDIDATE PAGE BLOCKS:

${finalSource}

Your task is to identify the smallest passage or passages that directly contain the information needed to answer the question.

CRITICAL:

- Do NOT answer the question.
- Return ORIGINAL text from the webpage.
- The text must be copied VERBATIM from one of the supplied blocks.
- Do not paraphrase.
- Do not rewrite.
- Do not combine separate blocks.
- Do not invent words.
- The selected text should normally be 1-3 sentences.
- Prefer the smallest passage that gives the useful information.
- You may return up to 3 passages.
- If none of the candidate blocks actually answers the question, return an empty evidence array.

The goal is for Snip to highlight this exact text on the original webpage.
`;

    let finalResult;

    try {
      finalResult = await askOpenAI({
        prompt: finalPrompt,
        schema: finalSchema,
        name: "snip_exact_evidence",
        maxOutputTokens: 1000
      });
    } catch (error) {
      console.error(
        "Final selection failed:",
        error.message
      );

      return res.status(200).json({
        evidence: []
      });
    }

    const proposed =
      Array.isArray(finalResult?.evidence)
        ? finalResult.evidence
        : [];

    /*
     * ---------------------------------------------------------
     * FINAL VALIDATION
     *
     * Never trust generated text blindly.
     *
     * Verify that the returned passage actually exists inside
     * the original block, while allowing whitespace differences.
     * ---------------------------------------------------------
     */

    function normalizeForMatch(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    const evidence = [];

    for (const item of proposed) {
      if (
        !item ||
        typeof item.block_id !== "string" ||
        typeof item.text !== "string"
      ) {
        continue;
      }

      const block = safeBlocks.find(
        b => b.id === item.block_id
      );

      if (!block) continue;

      const wanted = normalizeForMatch(
        item.text
      );

      const actual = normalizeForMatch(
        block.text
      );

      if (!wanted) continue;

      /*
       * Exact normalized containment.
       */
      if (actual.includes(wanted)) {
        evidence.push({
          block_id: block.id,
          text: item.text.trim()
        });

        continue;
      }

      /*
       * More tolerant matching for punctuation/formatting
       * differences.
       */
      const words = wanted
        .split(" ")
        .filter(Boolean);

      if (words.length >= 5) {
        let cursor = 0;
        let matched = true;

        for (const word of words) {
          const position = actual.indexOf(
            word,
            cursor
          );

          if (position === -1) {
            matched = false;
            break;
          }

          cursor = position + word.length;
        }

        if (matched) {
          /*
           * Use the original block text rather than invented
           * text if the model's formatting differed.
           */
          evidence.push({
            block_id: block.id,
            text: block.text
          });
        }
      }
    }

    /*
     * Remove duplicate evidence.
     */
    const uniqueEvidence = [];

    for (const item of evidence) {
      const duplicate =
        uniqueEvidence.some(
          existing =>
            existing.block_id === item.block_id &&
            normalizeForMatch(existing.text) ===
              normalizeForMatch(item.text)
        );

      if (!duplicate) {
        uniqueEvidence.push(item);
      }
    }

    return res.status(200).json({
      evidence: uniqueEvidence.slice(0, 3)
    });

  } catch (error) {
    console.error(
      "Snip API error:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Something went wrong"
    });
  }
}
