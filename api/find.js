export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
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

    // Clean and limit incoming page blocks.
    const safeBlocks = [];
    let totalChars = 0;

    for (const b of blocks) {
      if (
        !b ||
        typeof b.id !== "string" ||
        typeof b.text !== "string"
      ) {
        continue;
      }

      const id = b.id.slice(0, 80);
      const text = b.text.trim().slice(0, 1800);

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
     * Split the page into independent search windows.
     * This allows Snip to handle long webpages without putting
     * the entire page into a single AI request.
     */
    const CHUNK_CHARS = 30000;

    const chunks = [];
    let current = [];
    let currentChars = 0;

    for (const block of safeBlocks) {
      if (
        current.length &&
        currentChars + block.text.length > CHUNK_CHARS
      ) {
        chunks.push(current);
        current = [];
        currentChars = 0;
      }

      current.push(block);
      currentChars += block.text.length;
    }

    if (current.length) {
      chunks.push(current);
    }

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

    async function searchChunk(chunk) {
      const source = chunk
        .map(
          (b) =>
            `[${b.id}]\n${b.text}`
        )
        .join("\n\n");

      const prompt = `
You are Snip, an exact source locator.

User question:
${question}

Your job is NOT to answer the question.

Your job is to find the smallest passage or passages in this section that directly contain the information needed to answer the user's question.

Rules:

- Return at most 2 candidates.
- block_id must exactly match a supplied block ID.
- text must be copied VERBATIM from that block.
- Keep text as short as possible while retaining the useful information.
- Never paraphrase.
- Never combine text from different blocks.
- Never invent text.
- score is your confidence from 0 to 1 that the passage directly answers the user's question.
- If this section does not contain the answer, return an empty evidence array.

SOURCE BLOCKS:

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
            max_output_tokens: 600,
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
          "OpenAI chunk failed:",
          raw.slice(0, 1000)
        );

        return [];
      }

      let data;

      try {
        data = JSON.parse(raw);
      } catch (error) {
        console.error(
          "Could not parse OpenAI response:",
          error
        );

        return [];
      }

      const output = extractOutputText(data);

      if (!output) {
        return [];
      }

      let parsed;

      try {
        parsed = JSON.parse(output);
      } catch (error) {
        console.error(
          "Invalid chunk JSON:",
          output.slice(0, 500)
        );

        return [];
      }

      return Array.isArray(parsed?.evidence)
        ? parsed.evidence
        : [];
    }

    /*
     * Search all page sections in parallel.
     */
    const results = await Promise.all(
      chunks.map(searchChunk)
    );

    const candidates = results.flat();

    /*
     * Validate every returned passage against the original
     * page text before sending it back to the extension.
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
      .filter((item) => {
        const block = safeBlocks.find(
          (b) => b.id === item.block_id
        );

        return (
          block &&
          item.text &&
          block.text.includes(item.text)
        );
      })
      .sort(
        (a, b) => b.score - a.score
      )
      .slice(0, 3)
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
      error: "Function failed",
      details:
        process.env.NODE_ENV === "development"
          ? String(error?.message || error)
          : undefined
    });
  }
}
