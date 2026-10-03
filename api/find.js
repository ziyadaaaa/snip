import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  // Allow the Chrome extension to call this API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { question, blocks } = req.body || {};

    if (!question || !Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({
        error: "question and blocks are required",
      });
    }

    // Keep requests reasonably small
    const limitedBlocks = blocks.slice(0, 150);

    const response = await client.responses.create({
      model: "gpt-5-mini",
      store: false,
      instructions: `
You are an evidence locator.

The user asks a question about a webpage.

Your job is NOT to summarize or rewrite the webpage.

Find the smallest amount of source text that directly answers the question.

Return ONLY text copied exactly from the supplied webpage blocks.

Never invent words.
Never paraphrase.
Never combine words that do not appear together in a source block.

If no block directly answers the question, return an empty evidence array.

Return JSON with:
{
  "evidence": [
    {
      "block_id": "the source block id",
      "text": "exact copied text",
      "confidence": 0.0
    }
  ]
}

Prefer one strong passage over several weak passages.
      `,
      input: JSON.stringify({
        question,
        blocks: limitedBlocks,
      }),
      text: {
        format: {
          type: "json_schema",
          name: "evidence_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              evidence: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  properties: {
                    block_id: { type: "string" },
                    text: { type: "string" },
                    confidence: {
                      type: "number",
                      minimum: 0,
                      maximum: 1,
                    },
                  },
                  required: ["block_id", "text", "confidence"],
                  additionalProperties: false,
                },
              },
            },
            required: ["evidence"],
            additionalProperties: false,
          },
        },
      },
    });

    const result = JSON.parse(response.output_text || '{"evidence":[]}');

    // Safety check: make absolutely sure the AI returned
    // text that actually exists in the supplied source.
    const safeEvidence = result.evidence.filter((item) => {
      const block = limitedBlocks.find(
        (b) => String(b.id) === String(item.block_id)
      );

      return block && block.text.includes(item.text);
    });

    return res.status(200).json({
      evidence: safeEvidence,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "AI request failed",
    });
  }
}
