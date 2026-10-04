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
      .slice(0, 200)
      .map(b => ({
        id: b.id,
        text: b.text.slice(0, 2000)
      }));

    if (!safeBlocks.length) {
      return res.status(400).json({
        error: "No readable page content was found"
      });
    }

    const prompt = `
You are an exact webpage evidence locator.

The user asks:

${question.trim()}

Find the smallest passage from the supplied webpage blocks that directly answers the question.

Return ONLY valid JSON:

{
  "evidence": [
    {
      "block_id": "exact block id",
      "text": "exact text copied from the block"
    }
  ]
}

Rules:
- Return at most 3 items.
- Never paraphrase.
- Never invent text.
- The text must appear exactly inside the supplied block.
- If the answer cannot be found, return:
{"evidence":[]}

SOURCE BLOCKS:

${safeBlocks.map(b => `[${b.id}]\n${b.text}`).join("\n\n")}
`;

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-5-mini",
          input: prompt,
          store: false,
          max_output_tokens: 500
        })
      }
    );

    const raw = await response.text();

    if (!response.ok) {
      let details;

      try {
        details = JSON.parse(raw);
      } catch {
        details = {
          raw: raw.slice(0, 1000)
        };
      }

      console.error("OPENAI ERROR:", details);

      return res.status(502).json({
        error: "OpenAI request failed",
        status: response.status,
        code: details?.error?.code || null,
        type: details?.error?.type || null,
        message: details?.error?.message || details?.raw || null
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

    let parsed;

    try {
      parsed = JSON.parse(outputText);
    } catch {
      return res.status(502).json({
        error: "Invalid AI JSON response",
        raw: outputText.slice(0, 1000)
      });
    }

    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence
      : [];

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
          item.text &&
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
      error: "Function failed",
      message: error.message
    });
  }
}
