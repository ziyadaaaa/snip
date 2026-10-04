export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
    }

    const body = req.body || {};
    const question =
      typeof body.question === "string" ? body.question.trim() : "";
    const blocks = Array.isArray(body.blocks) ? body.blocks : null;

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

    if (blocks.length === 0) {
      return res.status(400).json({
        error: "No readable page content was found"
      });
    }

    if (blocks.length > 350) {
      return res.status(400).json({
        error: "Page contains too much content for one search"
      });
    }

    const safeBlocks = blocks
      .filter(
        b =>
          b &&
          typeof b.id === "string" &&
          typeof b.text === "string"
      )
      .map(b => ({
        id: b.id.slice(0, 80),
        text: b.text.trim().slice(0, 2500)
      }))
      .filter(b => b.id && b.text.length >= 10);

    if (!safeBlocks.length) {
      return res.status(400).json({
        error: "No readable page content was found"
      });
    }

    const source = safeBlocks
      .map(b => `[${b.id}]\n${b.text}`)
      .join("\n\n");

    const prompt = `You are Snip, an exact source locator.

User question:
${question}

Your job is NOT to answer the question. Your job is to identify the smallest passage(s) on this webpage that contain the information needed to answer it.

Return ONLY JSON in this exact shape:
{"evidence":[{"block_id":"...","text":"..."}]}

Rules:
- Return at most 3 evidence items.
- block_id must exactly match a supplied block ID.
- text must be copied verbatim from that block, including punctuation.
- Keep each text selection as short as possible while preserving the useful information.
- Never paraphrase, rewrite, combine, or invent text.
- If the page does not contain the requested information, return {"evidence":[]}.
- Do not include markdown or commentary.

SOURCE BLOCKS:
${source}`;

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
          store: false,
          max_output_tokens: 500
        })
      }
    );

    const raw = await openaiResponse.text();

    if (!openaiResponse.ok) {
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
    } catch {
      return res.status(502).json({
        error: "Invalid response from AI service"
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(data.output_text || "");
    } catch {
      console.error(
        "Invalid model JSON:",
        String(data.output_text || "").slice(0, 1000)
      );

      return res.status(502).json({
        error: "Snip received an invalid AI response"
      });
    }

    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence
      : [];

    const valid = evidence
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
      evidence: valid
    });
  } catch (error) {
    console.error("FUNCTION ERROR:", error);

    return res.status(500).json({
      error: "Function failed"
    });
  }
}
