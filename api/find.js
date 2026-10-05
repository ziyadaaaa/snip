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
    if (!process.env.OPENAI_API_KEY) {
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
        : null;

    if (!question || !blocks) {
      return res.status(400).json({
        error: "question and blocks are required"
      });
    }

    if (question.length > 1000) {
      return res.status(400).json({
        error: "Question is too long"
      });
    }

    if (!blocks.length) {
      return res.status(400).json({
        error: "No readable page content was found"
      });
    }

    if (blocks.length > 3000) {
      return res.status(400).json({
        error: "This page is too large for Snip"
      });
    }

    /*
     * ---------------------------------------------------------
     * CLEAN PAGE
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

      const id = block.id.slice(0, 80);
      const text = block.text.trim().slice(0, 1800);

      if (!id || text.length < 10) {
        continue;
      }

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
        error: "No readable page content was found"
      });
    }

    /*
     * ---------------------------------------------------------
     * HELPER: CALL OPENAI
     * ---------------------------------------------------------
     */

    async function callOpenAI(prompt, schema, name) {
      const response = await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization":
              `Bearer ${process.env.OPENAI_API_KEY}`
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
          })
        }
      );

      const raw = await response.text();

      if (!response.ok) {
        console.error(
          "OpenAI request failed:",
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

      if (
        typeof data?.output_text === "string" &&
        data.output_text.trim()
      ) {
        return JSON.parse(
          data.output_text.trim()
        );
      }

      const parts = [];

      for (
        const item of Array.isArray(data?.output)
          ? data.output
          : []
      ) {
        for (
          const content of Array.isArray(item?.content)
            ? item.content
            : []
        ) {
          if (
            content?.type === "output_text" &&
            typeof content.text === "string"
          ) {
            parts.push(content.text);
          }
        }
      }

      const output = parts.join("\n").trim();

      if (!output) {
        throw new Error("Empty OpenAI response");
      }

      return JSON.parse(output);
    }

    /*
     * ---------------------------------------------------------
     * PASS 1
     *
     * Understand the question and find the most relevant
     * sections of the page.
     *
     * This stage does NOT need to return exact highlight text.
     * It only identifies semantically relevant blocks.
     * ---------------------------------------------------------
     */

    const pageForRetrieval = safeBlocks
      .map(
        (block, index) =>
          `[BLOCK ${index}]
ID: ${block.id}
TEXT:
${block.text}`
      )
      .join("\n\n");

    const retrievalSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        relevant_blocks: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              block_id: {
                type: "string"
              },
              relevance: {
                type: "number",
                minimum: 0,
                maximum: 1
              },
              reason: {
                type: "string"
              }
            },
            required: [
              "block_id",
              "relevance",
              "reason"
            ]
          }
        }
      },
      required: [
        "relevant_blocks"
      ]
    };

    const retrievalPrompt = `
You are the semantic retrieval engine for Snip.

Snip finds where the answer to a user's question appears on a webpage.

USER QUESTION:
${question}

Below is the readable content of the webpage.

Your job is to UNDERSTAND the user's question and the webpage semantically.

Do NOT require the exact words from the question to appear in the page.

For example:

Question:
"Who were the astronauts?"

A page may say:
"The mission was crewed by Commander Neil Armstrong, Command Module Pilot Michael Collins, and Lunar Module Pilot Edwin 'Buzz' Aldrin."

That block is highly relevant even though the word "astronauts" may not appear.

Another example:

Question:
"What happened after they landed?"

A page may say:
"After more than 21 hours on the surface, they rejoined Collins in lunar orbit."

That passage is relevant because it describes what happened after the landing.

TASK:

Identify up to 8 blocks that could contain the answer.

Consider:
- synonyms
- implied meaning
- pronouns
- surrounding context
- chronology
- people and entities
- relationships between sections
- headings and section structure
- what the user is actually asking for

Do NOT invent information.

Only return block IDs that actually appear below.

PAGE:

${pageForRetrieval}
`;

    const retrievalResult = await callOpenAI(
      retrievalPrompt,
      retrievalSchema,
      "snip_retrieval"
    );

    const relevantBlocks =
      Array.isArray(
        retrievalResult?.relevant_blocks
      )
        ? retrievalResult.relevant_blocks
        : [];

    /*
     * Validate retrieval results against the actual page.
     */

    const candidateBlocks = relevantBlocks
      .filter(
        item =>
          item &&
          typeof item.block_id === "string"
      )
      .map(item => ({
        block_id: item.block_id,
        relevance: Number.isFinite(
          Number(item.relevance)
        )
          ? Number(item.relevance)
          : 0
      }))
      .filter(item =>
        safeBlocks.some(
          block =>
            block.id === item.block_id
        )
      )
      .sort(
        (a, b) =>
          b.relevance - a.relevance
      )
      .slice(0, 8)
      .map(item =>
        safeBlocks.find(
          block =>
            block.id === item.block_id
        )
      )
      .filter(Boolean);

    if (!candidateBlocks.length) {
      return res.status(200).json({
        evidence: []
      });
    }

    /*
     * ---------------------------------------------------------
     * PASS 2
     *
     * Now inspect only the semantically relevant sections.
     *
     * This is where we select the actual text to highlight.
     * ---------------------------------------------------------
     */

    const candidateSource = candidateBlocks
      .map(
        (block, index) =>
          `[CANDIDATE ${index}]
BLOCK ID: ${block.id}
TEXT:
${block.text}`
      )
      .join("\n\n");

    const evidenceSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        evidence: {
          type: "array",
          maxItems: 2,
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
              score: {
                type: "number",
                minimum: 0,
                maximum: 1
              }
            },
            required: [
              "block_id",
              "text",
              "score"
            ]
          }
        }
      },
      required: [
        "evidence"
      ]
    };

    const evidencePrompt = `
You are Snip's precision source locator.

The system has already identified the most semantically relevant parts of a webpage.

USER QUESTION:
${question}

CANDIDATE PAGE SECTIONS:

${candidateSource}

Now select the smallest original passage that answers the user's question.

IMPORTANT:

The question does NOT need to use the same words as the page.

Use semantic understanding.

Example:

Question:
"Who were the astronauts?"

Original page:
"The mission was crewed by Commander Neil Armstrong, Command Module Pilot Michael Collins, and Lunar Module Pilot Edwin 'Buzz' Aldrin."

Return the original sentence because it contains the answer.

Another example:

Question:
"How did Apollo 11 return to Earth?"

If the page says:
"The crew returned safely to Earth on July 24, splashing down in the Pacific Ocean."

That original sentence is useful evidence.

RULES:

1. Return at most 2 passages.
2. Prefer one passage when it fully answers the question.
3. Keep the selected passage as short as possible.
4. block_id MUST exactly match a candidate block ID.
5. text MUST be copied VERBATIM from that block.
6. Never paraphrase.
7. Never invent text.
8. Never combine text from multiple blocks into one text field.
9. The selected text must actually contain information needed to answer the question.
10. If none of the candidates answer the question, return an empty evidence array.

The goal is NOT to write an answer.

The goal is to tell Snip exactly which original words on the page should be highlighted.
`;

    const evidenceResult = await callOpenAI(
      evidencePrompt,
      evidenceSchema,
      "snip_evidence"
    );

    const candidates =
      Array.isArray(
        evidenceResult?.evidence
      )
        ? evidenceResult.evidence
        : [];

    /*
     * ---------------------------------------------------------
     * FINAL VALIDATION
     *
     * Never allow AI-generated text that doesn't actually exist
     * in the webpage to reach the extension.
     * ---------------------------------------------------------
     */

    const valid = candidates
      .filter(
        item =>
          item &&
          typeof item.block_id === "string" &&
          typeof item.text === "string"
      )
      .map(item => ({
        block_id: item.block_id,
        text: item.text.trim(),
        score: Number.isFinite(
          Number(item.score)
        )
          ? Math.max(
              0,
              Math.min(
                1,
                Number(item.score)
              )
            )
          : 0
      }))
      .filter(item => {
        const block = safeBlocks.find(
          b =>
            b.id === item.block_id
        );

        if (!block || !item.text) {
          return false;
        }

        return block.text.includes(
          item.text
        );
      })
      .sort(
        (a, b) =>
          b.score - a.score
      )
      .slice(0, 2)
      .map(
        ({ block_id, text }) => ({
          block_id,
          text
        })
      );

    return res.status(200).json({
      evidence: valid
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
