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

    const { question, blocks } = req.body || {};

    if (
      typeof question !== "string" ||
      !question.trim() ||
      !Array.isArray(blocks)
    ) {
      return res.status(400).json({
        error: "question and blocks are required"
      });
    }

    const safeBlocks = blocks
      .filter(
        b =>
          b &&
          typeof b.id === "string" &&
          typeof b.text === "string"
      )
      .slice(0, 250)
      .map(b => ({
        id: b.id.slice(0, 100),
        text: b.text.trim().slice(0, 2500)
      }))
      .filter(b => b.text.length > 0);

    if (!safeBlocks.length) {
      return res.status(400).json({
        error: "No readable page content was found"
      });
    }

    const prompt = `
You are Snip, an exact webpage-location finder.

The user asks:

${question.trim()}

Find the smallest passage or passages in the supplied webpage blocks that directly contain the information needed to answer the question.

IMPORTANT:
- Do NOT answer the question.
- Do NOT summarize.
- Do NOT paraphrase.
- Only select text that appears exactly in the supplied blocks.
- Return at most 3 passages.
- If the information is not present, return no evidence.

SOURCE BLOCKS:

${safeBlocks
  .map(b => `[${b.id}]\n${b.text}`)
  .join("\n\n")}
`;

    const openaiResponse = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
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
              schema: {
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
                      required: ["block_id", "text"]
                    }
                  }
                },
                required: ["evidence"]
              }
            }
          }
        })
      }
    );

    const raw = await openaiResponse.text();

    if (!openaiResponse.ok) {
      let details;

      try {
        details = JSON.parse(raw);
      } catch {
        details = {};
      }

      console.error("OPENAI ERROR:", details);

      return res.status(502).json({
        error: "OpenAI request failed",
        status: openaiResponse.status,
        code: details?.error?.code || null,
        message: details?.error?.message || null
      });
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Invalid OpenAI response"
      });
    }

    const outputText = data.output_text || "";

    let result;

    try {
      result = JSON.parse(outputText);
    } catch {
      return res.status(502).json({
        error: "Invalid AI JSON response"
      });
    }

    const evidence = Array.isArray(result.evidence)
      ? result.evidence
      : [];

    // Verify every selected passage against the actual source.
    const verified = evidence
      .filter(
        item =>
          item &&
          typeof item.block_id === "string" &&
          typeof item.text === "string"
      )
      .map(item => ({
        block_id: item.block_id,
        text: item.text.trim()
      }))
      .filter(item => {
        const block = safeBlocks.find(
          b => b.id === item.block_id
        );

        return (
          block &&
          item.text.length > 0 &&
          block.text.includes(item.text)
        );
      })
      .slice(0, 3);

    return res.status(200).json({
      evidence: verified
    });
  } catch (error) {
    console.error("FUNCTION ERROR:", error);

    return res.status(500).json({
      error: "Function failed"
    });
  }
}
