export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).json({ ok: true });
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

    if (!question || !Array.isArray(blocks)) {
      return res.status(400).json({
        error: "question and blocks are required"
      });
    }

    const prompt = `
You are an evidence locator.

The user asks:

${question}

Below are source blocks taken directly from the webpage.

Find the smallest number of blocks containing the exact information needed to answer the user's question.

IMPORTANT:
- Do NOT paraphrase.
- Do NOT invent text.
- Return only text that appears exactly inside the supplied blocks.
- Prefer the most directly relevant passage.
- Return at most 3 pieces of evidence.

SOURCE BLOCKS:

${blocks.map(b => `[${b.id}]\n${b.text}`).join("\n\n")}
`;

    const openaiResponse = await fetch(
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
          store: false
        })
      }
    );

    const raw = await openaiResponse.text();

    if (!openaiResponse.ok) {
      console.error("OpenAI error:", raw);

      return res.status(502).json({
        error: "OpenAI request failed",
        details: raw
      });
    }

    const data = JSON.parse(raw);

    const outputText = data.output_text || "";

    return res.status(200).json({
      evidence: [],
      raw: outputText
    });

  } catch (error) {
    console.error("FUNCTION ERROR:", error);

    return res.status(500).json({
      error: "Function failed",
      details: error.message
    });
  }
}
