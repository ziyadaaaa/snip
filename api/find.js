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
     * ---------------------------------------------------------
     * CLEAN PAGE BLOCKS
     * ---------------------------------------------------------
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

      if (!id || text.length < 10) {
        continue;
      }

      /*
       * Protect the API from accidentally enormous pages.
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
     * OPENAI HELPER
     * ---------------------------------------------------------
     */

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
          raw.slice(0, 2000)
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
          if (!Array.isArray(item.content)) {
            continue;
          }

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
        throw new Error(
          "AI returned no usable output"
        );
      }

      try {
        return JSON.parse(outputText);
      } catch {
        console.error(
          "AI returned invalid JSON:",
          outputText.slice(0, 1500)
        );

        throw new Error(
          "Invalid AI JSON response"
        );
      }
    }

    /*
     * ---------------------------------------------------------
     * SPLIT PAGE INTO CHUNKS
     * ---------------------------------------------------------
     *
     * We search each chunk independently so large webpages
     * don't overwhelm a single model call.
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

    /*
     * ---------------------------------------------------------
     * STAGE 1 — SEMANTIC RETRIEVAL
     * ---------------------------------------------------------
     */

    const candidateSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        candidates: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              block_id: {
                type: "string"
              },
              score: {
                type: "number"
              },
              reason: {
                type: "string"
              }
            },
            required: [
              "block_id",
              "score",
              "reason"
            ]
          }
        }
      },
      required: [
        "candidates"
      ]
    };

    async function searchChunk(chunk) {
      const source = chunk
        .map(
          block =>
            `[${block.id}]\n${block.text}`
        )
        .join("\n\n");

      const prompt = `
You are the semantic retrieval engine for Snip.

Snip does NOT answer the user's question.

Snip finds the exact part of the webpage that contains the information needed to answer the question.

USER QUESTION:
${question}

PAGE CONTENT:

${source}

TASK:

Find the blocks most likely to contain the information needed to answer the user's question.

Think about MEANING, CONTEXT, EVENTS, PEOPLE, ACTIONS, DATES, LOCATIONS, CAUSES, RESULTS, and SEQUENCES.

The user's wording may be completely different from the wording on the page.

Example:

Question:
"How did Apollo 11 return to Earth?"

Page:
"The crew returned safely to Earth on July 24, splashing down in the Pacific Ocean."

This is a strong match even though the page does not literally contain the phrase:
"How did Apollo 11 return to Earth?"

Another example:

Question:
"What was the quarantine procedure after the astronauts returned?"

Relevant page text might discuss:
- biological isolation garments
- the life raft
- decontamination
- the recovery helicopter
- the mobile quarantine facility
- 21 days of quarantine

These concepts are related even if the word "procedure" is not present.

IMPORTANT:

- Search by meaning, not exact wording.
- Understand what information the user is actually asking for.
- Consider synonyms and related concepts.
- Consider descriptions of the same event using different wording.
- Consider nearby context.
- Prefer blocks containing actual evidence.
- Do not choose blocks merely because they mention the same general topic.
- Only return block IDs that actually exist above.
- Never invent block IDs.
- Do not answer the question.
- Do not quote page text.
- If nothing in this chunk is useful, return an empty candidates array.

Return up to 8 strong candidates.

Give each candidate a relevance score from 0 to 100.
`;

      try {
        const result = await askOpenAI({
          prompt,
          schema: candidateSchema,
          name: "snip_semantic_candidates",
          maxOutputTokens: 1000
        });

        if (
          !result ||
          !Array.isArray(result.candidates)
        ) {
          return [];
        }

        return result.candidates;
      } catch (error) {
        console.error(
          "Chunk search failed:",
          error.message
        );

        return [];
      }
    }

    /*
     * Search chunks concurrently.
     */

    const chunkResults = await Promise.all(
      chunks.map(searchChunk)
    );

    /*
     * ---------------------------------------------------------
     * COMBINE + RANK CANDIDATES
     * ---------------------------------------------------------
     */

    const candidateMap = new Map();

    for (const result of chunkResults) {
      for (const candidate of result) {
        if (
          !candidate ||
          typeof candidate.block_id !== "string"
        ) {
          continue;
        }

        const blockExists = safeBlocks.some(
          block =>
            block.id === candidate.block_id
        );

        if (!blockExists) {
          continue;
        }

        const score =
          typeof candidate.score === "number"
            ? Math.max(
                0,
                Math.min(100, candidate.score)
              )
            : 0;

        const existing =
          candidateMap.get(
            candidate.block_id
          );

        if (
          !existing ||
          score > existing.score
        ) {
          candidateMap.set(
            candidate.block_id,
            {
              block_id: candidate.block_id,
              score,
              reason:
                typeof candidate.reason === "string"
                  ? candidate.reason
                  : ""
            }
          );
        }
      }
    }

    /*
     * Sort candidates by semantic relevance.
     */

    const rankedCandidates = [
      ...candidateMap.values()
    ].sort(
      (a, b) =>
        b.score - a.score
    );

    /*
     * ---------------------------------------------------------
     * EXPAND CANDIDATES WITH NEIGHBORING BLOCKS
     * ---------------------------------------------------------
     *
     * This is extremely important.
     *
     * Webpages often split one logical paragraph or event
     * across several DOM blocks.
     *
     * If block 50 is relevant, blocks 49 and 51 may contain
     * the context needed to understand it.
     */

    const expandedIdSet = new Set();

    for (
      const candidate of rankedCandidates.slice(0, 15)
    ) {
      const index =
        safeBlocks.findIndex(
          block =>
            block.id === candidate.block_id
        );

      if (index === -1) {
        continue;
      }

      /*
       * Include one block before and two blocks after.
       *
       * This gives the final model enough local context
       * without dumping the entire page back into the prompt.
       */

      for (
        let i =
          Math.max(0, index - 1);
        i <=
          Math.min(
            safeBlocks.length - 1,
            index + 2
          );
        i++
      ) {
        expandedIdSet.add(
          safeBlocks[i].id
        );
      }
    }

    let candidateBlocks = safeBlocks.filter(
      block =>
        expandedIdSet.has(block.id)
    );

    /*
     * If semantic retrieval somehow returned nothing,
     * don't immediately fail. Try a broader fallback search
     * using the first portion of the page.
     */

    if (!candidateBlocks.length) {
      const fallbackBlocks =
        safeBlocks.slice(0, 40);

      candidateBlocks = fallbackBlocks;
    }

    /*
     * Limit the final context.
     */

    candidateBlocks =
      candidateBlocks.slice(0, 40);

    /*
     * ---------------------------------------------------------
     * STAGE 2 — EXACT LOCATION SELECTION
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
              },
              relevance: {
                type: "number"
              }
            },
            required: [
              "block_id",
              "text",
              "relevance"
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

Snip's purpose is:

USER QUESTION
↓
FIND THE EXACT PART OF THE WEBPAGE THAT MATTERS
↓
HIGHLIGHT IT

Snip does NOT answer the user's question.

USER QUESTION:

${question}

CANDIDATE PAGE BLOCKS:

${finalSource}

TASK:

Identify the smallest original passage or passages that contain the information needed to answer the user's question.

Think semantically.

The wording of the question may be completely different from the wording of the webpage.

Example:

Question:
"How did Apollo 11 return to Earth?"

Possible relevant webpage text:

"They rejoined Collins in lunar orbit, and the crew returned safely to Earth on July 24, splashing down in the Pacific Ocean."

This is relevant because it describes the actual return.

IMPORTANT RULES:

1. DO NOT answer the question.

2. Return ORIGINAL webpage text only.

3. The returned text must be copied VERBATIM from the supplied blocks.

4. Never paraphrase.

5. Never rewrite.

6. Never invent words.

7. Never combine unrelated blocks.

8. Prefer the smallest useful passage.

9. Normally select 1-3 sentences.

10. If one sentence is enough, select one sentence.

11. If understanding the answer requires adjacent context, select the smallest contiguous passage necessary.

12. A passage does NOT need to contain the exact words from the question.

13. Do not select text merely because it shares keywords.

14. Prefer evidence that directly explains the requested event, action, cause, result, procedure, person, date, or outcome.

15. If none of the supplied blocks actually contain useful evidence, return an empty evidence array.

16. Never fabricate evidence.

The final text will be highlighted directly on the original webpage, so accuracy is extremely important.

Return up to 3 evidence passages.
`;

    let finalResult;

    try {
      finalResult = await askOpenAI({
        prompt: finalPrompt,
        schema: finalSchema,
        name: "snip_exact_evidence",
        maxOutputTokens: 1200
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
      Array.isArray(
        finalResult?.evidence
      )
        ? finalResult.evidence
        : [];

    /*
     * ---------------------------------------------------------
     * TEXT NORMALIZATION
     * ---------------------------------------------------------
     */

    function normalizeForMatch(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    /*
     * Remove punctuation that commonly differs between
     * webpage extraction and model output.
     */

    function normalizeLoose(value) {
      return normalizeForMatch(value)
        .replace(
          /[.,!?;:"'“”‘’()[\]{}—–-]/g,
          ""
        );
    }

    /*
     * ---------------------------------------------------------
     * VALIDATE AI EVIDENCE
     * ---------------------------------------------------------
     */

    const evidence = [];

    for (const item of proposed) {
      if (
        !item ||
        typeof item.block_id !== "string" ||
        typeof item.text !== "string"
      ) {
        continue;
      }

      const block =
        safeBlocks.find(
          b =>
            b.id === item.block_id
        );

      if (!block) {
        continue;
      }

      const wanted =
        normalizeForMatch(
          item.text
        );

      const actual =
        normalizeForMatch(
          block.text
        );

      if (!wanted) {
        continue;
      }

      /*
       * Best case:
       * exact normalized containment.
       */

      if (actual.includes(wanted)) {
        evidence.push({
          block_id: block.id,
          text: item.text.trim(),
          relevance:
            typeof item.relevance === "number"
              ? item.relevance
              : 100
        });

        continue;
      }

      /*
       * Second case:
       * punctuation / quote / dash differences.
       */

      const wantedLoose =
        normalizeLoose(
          item.text
        );

      const actualLoose =
        normalizeLoose(
          block.text
        );

      if (
        wantedLoose &&
        actualLoose.includes(
          wantedLoose
        )
      ) {
        /*
         * The model's text is semantically and
         * textually identical after normalization.
         *
         * Return the original block text only when
         * the selected text is effectively the whole
         * block. Otherwise reject it rather than
         * highlighting inaccurate text.
         */

        const originalLength =
          normalizeLoose(
            block.text
          ).length;

        const selectedLength =
          wantedLoose.length;

        if (
          selectedLength >=
          originalLength * 0.85
        ) {
          evidence.push({
            block_id: block.id,
            text: block.text,
            relevance:
              typeof item.relevance === "number"
                ? item.relevance
                : 90
          });
        }

        continue;
      }

      /*
       * Do NOT blindly accept fuzzy word matching.
       *
       * Snip must highlight real webpage text.
       */
    }

    /*
     * ---------------------------------------------------------
     * REMOVE DUPLICATES
     * ---------------------------------------------------------
     */

    const uniqueEvidence = [];

    for (const item of evidence) {
      const duplicate =
        uniqueEvidence.some(
          existing =>
            existing.block_id ===
              item.block_id &&
            normalizeForMatch(
              existing.text
            ) ===
              normalizeForMatch(
                item.text
              )
        );

      if (!duplicate) {
        uniqueEvidence.push(
          item
        );
      }
    }

    /*
     * ---------------------------------------------------------
     * FINAL RANKING
     * ---------------------------------------------------------
     */

    uniqueEvidence.sort(
      (a, b) =>
        (b.relevance || 0) -
        (a.relevance || 0)
    );

    /*
     * ---------------------------------------------------------
     * RESPONSE
     * ---------------------------------------------------------
     */

    return res.status(200).json({
      evidence:
        uniqueEvidence
          .slice(0, 3)
          .map(item => ({
            block_id:
              item.block_id,
            text:
              item.text
          }))
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
