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

    // Clean the page while preserving the original text.
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
     * IMPORTANT:
     *
     * We intentionally send the page as ONE connected document.
     *
     * Snip should understand relationships between sections instead
     * of independently asking an AI model about isolated chunks.
     */
    const source = safeBlocks
      .map(
        (block, index) =>
          `[BLOCK ${index}]
ID: ${block.id}
TEXT:
${block.text}`
      )
      .join("\n\n");

    const schema = {
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

    const prompt = `
You are Snip, an AI-powered precision navigation system.

You are looking at the COMPLETE readable content of a webpage.

USER QUESTION:
${question}

YOUR TASK:

Understand the meaning of the user's question and understand the webpage as a whole.

Then identify the smallest useful passage on the ORIGINAL webpage that contains the information needed to answer the question.

IMPORTANT:

The user's wording does NOT need to appear in the webpage.

Use semantic understanding.

For example:

Question:
"Who were the astronauts?"

Page:
"The mission was crewed by Commander Neil Armstrong, Command Module Pilot Michael Collins, and Lunar Module Pilot Edwin 'Buzz' Aldrin."

This is relevant even though the word "astronauts" does not appear in that passage.

Another example:

Question:
"What happened after they landed?"

The page might say:
"After more than 21 hours on the surface, they rejoined Collins in lunar orbit."

Understand that this describes what happened after the lunar landing even if those exact words are not present.

RULES:

1. Understand the entire page before choosing evidence.
2. Use the question's meaning, not exact keyword matching.
3. Use context from other parts of the page when deciding what a passage means.
4. Prefer the smallest passage that actually contains the answer.
5. Return at most 2 passages.
6. block_id MUST exactly match one of the supplied block IDs.
7. text MUST be copied VERBATIM from that block.
8. Do not paraphrase the returned text.
9. Do not invent text.
10. Do not combine text from different blocks into one text field.
11. If a question is answered by one paragraph, prefer that paragraph over several unrelated snippets.
12. If the page does not contain enough information to answer the question, return an empty evidence array.
13. score represents confidence that the selected passage directly answers the user's question.

The goal is NOT to answer the user in your own words.

The goal is to FIND WHERE THE ANSWER IS ON THE ORIGINAL PAGE.

COMPLETE WEBPAGE:

${source}
`;

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
          max_output_tokens: 1000,
          text: {
            format: {
              type: "json_schema",
              name: "snip_evidence",
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

      return res.status(502).json({
        error: "OpenAI request failed"
      });
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error(
        "Could not parse OpenAI response:",
        raw.slice(0, 2000)
      );

      return res.status(502).json({
        error: "Invalid OpenAI response"
      });
    }

    function extractOutputText(data) {
      if (
        typeof data?.output_text === "string" &&
        data.output_text.trim()
      ) {
        return data.output_text.trim();
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

      return parts.join("\n").trim();
    }

    const output = extractOutputText(data);

    if (!output) {
      return res.status(200).json({
        evidence: []
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(output);
    } catch (error) {
      console.error(
        "Invalid structured output:",
        output.slice(0, 2000)
      );

      return res.status(502).json({
        error: "Invalid AI result"
      });
    }

    const candidates = Array.isArray(parsed?.evidence)
      ? parsed.evidence
      : [];

    /*
     * Validate the AI's selected passages against the actual
     * webpage content. This prevents hallucinated text from
     * ever being sent to the extension.
     */
    const valid = candidates
      .filter(
        (item) =>
          item &&
          typeof item.block_id === "string" &&
          typeof item.text === "string"
      )
      .map((item) => ({
        block_id: item.block_id,
        text: item.text.trim(),
        score: Number.isFinite(Number(item.score))
          ? Math.max(
              0,
              Math.min(
                1,
                Number(item.score)
              )
            )
          : 0
      }))
      .filter((item) => {
        const block = safeBlocks.find(
          (b) => b.id === item.block_id
        );

        if (!block || !item.text) {
          return false;
        }

        return block.text.includes(item.text);
      })
      .sort(
        (a, b) => b.score - a.score
      )
      .slice(0, 2)
      .map(({ block_id, text }) => ({
        block_id,
        text
      }));

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
