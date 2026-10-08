export default async function handler(req, res) {
  // ======================================================
  // CORS
  // ======================================================

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { question, blocks } = req.body || {};

    if (!question || typeof question !== "string") {
      return res.status(400).json({
        error: "Missing question"
      });
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({
        error: "Missing blocks"
      });
    }

    // ====================================================
    // Clean page blocks
    // ====================================================

    const cleanedBlocks = blocks
      .map((block, i) => ({
        index: Number.isInteger(block?.index)
          ? block.index
          : i,

        text: String(block?.text || "")
          .replace(/\s+/g, " ")
          .trim(),

        kind: block?.kind || "text",

        section: String(block?.section || "").trim()
      }))
      .filter(block => block.text.length > 0);

    if (!cleanedBlocks.length) {
      return res.status(400).json({
        error: "No usable page content"
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error("OPENAI_API_KEY is missing");

      return res.status(500).json({
        error: "Server configuration error"
      });
    }

    // ====================================================
    // Question analysis
    // ====================================================

    const questionInfo = analyzeQuestion(question);

    // ====================================================
    // Build ALL sentences
    // ====================================================

    const sentences = [];

    for (const block of cleanedBlocks) {
      const parts = splitIntoSentences(block.text);

      for (let i = 0; i < parts.length; i++) {
        const sentence = parts[i].trim();

        if (!sentence) continue;

        sentences.push({
          id: sentences.length,
          block_index: block.index,
          sentence,
          section: block.section,
          kind: block.kind,
          sentence_index: i
        });
      }
    }

    if (!sentences.length) {
      return res.status(200).json({
        evidence: []
      });
    }

    // ====================================================
    // Rank sentences locally
    // ====================================================

    const ranked = sentences
      .map(item => ({
        ...item,
        score: scoreSentence(
          item,
          questionInfo
        )
      }))
      .sort((a, b) => b.score - a.score);

    // ====================================================
    // Select candidates
    // ====================================================

    const selected = selectCandidates(
      ranked,
      sentences,
      questionInfo
    );

    const candidateText = selected
      .map((item, i) => {
        const hints = [];

        if (item.score >= 80) {
          hints.push("STRONG-CANDIDATE");
        }

        if (
          questionInfo.isDuration &&
          hasDuration(item.sentence)
        ) {
          hints.push("HAS-DURATION");
        }

        if (
          questionInfo.isLocation &&
          hasLocationSignal(item.sentence)
        ) {
          hints.push("HAS-LOCATION");
        }

        if (
          questionInfo.isWho &&
          hasPersonSignal(item.sentence)
        ) {
          hints.push("HAS-PERSON");
        }

        if (
          questionInfo.isWhen &&
          hasDateSignal(item.sentence)
        ) {
          hints.push("HAS-DATE");
        }

        return [
          `[${i}]`,
          `block=${item.block_index}`,
          `score=${item.score}`,
          hints.length ? hints.join(" ") : "",
          item.sentence
        ]
          .filter(Boolean)
          .join(" ");
      })
      .join("\n\n");

    // ====================================================
    // Ask OpenAI to select exact evidence
    // ====================================================

    const prompt = `
You are Snip, an exact-location webpage retrieval system.

USER QUESTION:
${question}

Your job is NOT to summarize the webpage.

Your job is to find the exact sentence or sentences on the supplied webpage that directly answer the user's question.

IMPORTANT:
The webpage may contain many related sentences.
Do NOT choose a sentence just because it shares keywords with the question.

Choose the sentence that actually answers the question.

RULES:

1. Prefer ONE sentence when one sentence directly answers the question.
2. Use TWO sentences only when the answer genuinely requires both.
3. Prefer the smallest possible evidence.
4. Never invent information.
5. Never answer from general knowledge.
6. The passage MUST be copied exactly from the supplied webpage sentence.
7. Do not rewrite the sentence.
8. Do not combine unrelated sentences.
9. Do not choose a sentence merely because it contains a date, name, number, or location.
10. If the webpage does not contain the answer, return an empty evidence array.

WHO:
- Find the sentence that explicitly identifies the requested person or people.
- Match the person to the specific action, role, event, or relationship asked about.
- For questions like "Who stayed in lunar orbit?", prefer a sentence identifying the person who stayed/remained in orbit.
- For questions like "Who was the first person to walk on the Moon?", prefer the sentence identifying the first person.
- A sentence mentioning "astronauts", "the crew", or another generic group is NOT enough unless it directly answers the question.
- Do not choose an unrelated technical sentence merely because it mentions astronauts or a person's name.
- Prefer explicit relationships such as "Collins remained...", "Armstrong became...", "Captain Smith commanded...", etc.

WHEN:
- Find the date/time that specifically answers the event in the question.
- Do not choose an earlier or later date simply because it is prominent.

WHERE:
- Find where the event actually occurred.
- For a landing question, prefer the actual landing location.
- Do not select a sentence saying someone later viewed, observed, photographed, or mapped the location.

HOW LONG:
- Find the duration of the specific event/stay/period asked about.
- Distinguish total duration from durations of individual activities.
- For a question asking how long people stayed somewhere, prefer explicit stay/surface/location duration.
- Do not select "34 minutes" merely because it is a duration if the question asks about an entire mission or stay.

HOW MANY:
- Find the number that answers the specific quantity requested.
- Do not choose another nearby number.

WHY:
- Find the sentence explaining the cause/reason.
- Do not choose a sentence merely describing the event.

WHAT:
- Find the sentence that directly defines, identifies, or explains the thing being asked about.

WHICH:
- Find the sentence that identifies the requested item.

The candidate list has been locally ranked before reaching you.
Higher scores are useful signals, but you must still verify the actual meaning.

Return JSON only:

{
  "evidence": [
    {
      "block_index": 123,
      "passage": "exact sentence copied from the webpage"
    }
  ]
}

WEBPAGE CANDIDATES:

${candidateText}
`;

    const response =
      await callOpenAI(apiKey, prompt);

    const parsed =
      parseModelJSON(response);

    if (
      !parsed ||
      !Array.isArray(parsed.evidence)
    ) {
      throw new Error(
        "Invalid model response"
      );
    }

    // ====================================================
    // Validate model evidence
    // ====================================================

    const validEvidence = [];

    for (const item of parsed.evidence.slice(0, 2)) {
      if (!item) continue;

      const blockIndex =
        Number(item.block_index);

      const passage =
        String(item.passage || "").trim();

      if (
        !Number.isInteger(blockIndex) ||
        !passage
      ) {
        continue;
      }

      const sourceBlock =
        cleanedBlocks.find(
          block => block.index === blockIndex
        );

      if (!sourceBlock) continue;

      if (
        containsEquivalentText(
          sourceBlock.text,
          passage
        )
      ) {
        validEvidence.push({
          block_index: blockIndex,
          passage
        });
      }
    }

    // ====================================================
    // Precision / semantic validation
    // ====================================================

    if (
      validEvidence.length === 0 ||
      needsPrecisionOverride(
        validEvidence,
        questionInfo
      )
    ) {
      const fallback =
        findBestDeterministicSentence(
          question,
          cleanedBlocks
        );

      if (fallback) {
        return res.status(200).json({
          evidence: [fallback]
        });
      }

      return res.status(200).json({
        evidence: []
      });
    }

    // ====================================================
    // Remove duplicate evidence
    // ====================================================

    const uniqueEvidence = [];

    const seen = new Set();

    for (const item of validEvidence) {
      const key =
        `${item.block_index}|${normalizeText(item.passage)}`;

      if (seen.has(key)) continue;

      seen.add(key);
      uniqueEvidence.push(item);
    }

    return res.status(200).json({
      evidence: uniqueEvidence
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


// ======================================================
// QUESTION ANALYSIS
// ======================================================

function analyzeQuestion(question) {
  const q =
    String(question || "")
      .toLowerCase()
      .trim();

  return {
    raw: q,

    isWho:
      /\bwho\b/.test(q),

    isWhen:
      /\bwhen\b/.test(q) ||
      /\bwhat date\b/.test(q) ||
      /\bwhat time\b/.test(q),

    isWhere:
      /\bwhere\b/.test(q) ||
      /\bwhat location\b/.test(q) ||
      /\bwhich location\b/.test(q),

    isDuration:
      /\bhow long\b/.test(q) ||
      /\bhow many\s+(hours?|minutes?|days?|weeks?|months?|years?)\b/.test(q) ||
      /\bwhat was the duration\b/.test(q),

    isHowMany:
      /\bhow many\b/.test(q) ||
      /\bhow much\b/.test(q),

    isWhy:
      /\bwhy\b/.test(q) ||
      /\bwhat caused\b/.test(q) ||
      /\bwhat was the cause\b/.test(q),

    isWhat:
      /^\s*what\b/.test(q),

    isWhich:
      /\bwhich\b/.test(q),

    isRelationship:
  /\b(?:husband|wife|father|mother|son|daughter|brother|sister|partner|spouse)\b/.test(q),
   
    terms: extractQuestionTerms(q)
  };
}


// ======================================================
// QUESTION TERMS
// ======================================================

function extractQuestionTerms(q) {
  const stopWords = new Set([
    "what",
    "when",
    "where",
    "who",
    "why",
    "which",
    "how",
    "long",
    "many",
    "much",
    "was",
    "were",
    "is",
    "are",
    "did",
    "do",
    "does",
    "the",
    "a",
    "an",
    "of",
    "to",
    "in",
    "on",
    "at",
    "for",
    "and",
    "or",
    "from",
    "with",
    "about",
    "this",
    "that",
    "it",
    "they",
    "he",
    "she",
    "their",
    "his",
    "her",
    "people",
    "person",
    "event"
  ]);

  return q
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map(word => word.trim())
    .filter(
      word =>
        word.length >= 2 &&
        !stopWords.has(word)
    );
}


// ======================================================
// LOCAL SENTENCE SCORING
// ======================================================

function scoreSentence(
  item,
  info
) {
  const s =
    item.sentence.toLowerCase();

  const section =
    item.section.toLowerCase();

  let score = 0;

  // ----------------------------------------------------
  // Question term overlap
  // ----------------------------------------------------

  for (const term of info.terms) {
    if (!term) continue;

    if (containsWord(s, term)) {
      score += 12;
    }

    if (
      term.length >= 6 &&
      s.includes(term)
    ) {
      score += 5;
    }

    if (
      section &&
      containsWord(section, term)
    ) {
      score += 3;
    }
  }

  // ----------------------------------------------------
  // WHO
  // ----------------------------------------------------

  if (info.isWho) {
    const hasPerson =
      hasPersonSignal(item.sentence);

    const genericPeople =
      /\b(?:the\s+)?(?:astronauts?|crew|people|scientists?|researchers?|soldiers?|members?|officials?)\b/i
        .test(item.sentence);

    const explicitIdentity =
      /\b(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married|husband|wife|brother|sister)\b/i
        .test(item.sentence);

    // Extremely strong pattern for:
    // "Who stayed in lunar orbit?"
    // "Who remained in lunar orbit?"
    if (
      /\b(?:stayed|remained)\b/i.test(item.sentence) &&
      /\b(?:lunar orbit|orbit)\b/i.test(item.sentence)
    ) {
      score += 180;
    }

    // Person + meaningful action/relationship.
    if (
      hasPerson &&
      explicitIdentity
    ) {
      score += 100;
    }

    if (hasPerson) {
      score += 45;
    }

    if (explicitIdentity) {
      score += 30;
    }

    // Generic group references are weak.
    if (
      genericPeople &&
      !hasPerson
    ) {
      score -= 100;
    }

    // Technical sentences that only mention
    // astronauts/crew should be strongly penalized.
    if (
      genericPeople &&
      !explicitIdentity &&
      !hasPerson
    ) {
      score -= 80;
    }

    // A sentence that only says someone "said" something
    // is weaker unless the question is explicitly about who said it.
    if (
      /\baccording to\b|\bsaid\b|\breported\b/.test(s) &&
      !explicitIdentity
    ) {
      score -= 10;
    }
  }

  // ----------------------------------------------------
  // WHEN
  // ----------------------------------------------------

  if (info.isWhen) {
    if (hasDateSignal(item.sentence)) {
      score += 55;
    }

    if (
      /\bstarted\b|\bbegan\b|\bended\b|\bended on\b|\blaunched\b|\bsank\b|\bdied\b|\barrived\b|\boccurred\b|\btook place\b/.test(s)
    ) {
      score += 35;
    }
  }

  // ----------------------------------------------------
  // WHERE
  // ----------------------------------------------------

  if (info.isWhere) {
    if (hasLocationSignal(item.sentence)) {
      score += 45;
    }

    if (
      /\blanded\b|\blanding\b|\btouched down\b|\barrived\b|\bdescended\b|\breached\b|\boccurred\b|\btook place\b/.test(s)
    ) {
      score += 45;
    }

    if (
      /\bsaw\b.*\blanding site\b/.test(s) ||
      /\bpassing views\b/.test(s)
    ) {
      score -= 90;
    }
  }

  // ----------------------------------------------------
  // HOW LONG
  // ----------------------------------------------------

  if (info.isDuration) {
    if (hasDuration(item.sentence)) {
      score += 70;
    }

    if (
      /\bafter\b.*\bhours?\b.*\bsurface\b/.test(s)
    ) {
      score += 70;
    }

    if (
      /\bon the (?:lunar )?surface\b/.test(s)
    ) {
      score += 55;
    }

    if (
      /\bon the moon\b/.test(s)
    ) {
      score += 55;
    }

    if (
      /\ballotted\b|\ballocated\b|\bsample collection\b|\bdocumenting\b|\bhalfway\b|\bactivity\b|\bexperiment\b/.test(s)
    ) {
      score -= 110;
    }
  }

  // ----------------------------------------------------
  // HOW MANY
  // ----------------------------------------------------

  if (info.isHowMany) {
    if (
      /\b\d+(?:\.\d+)?\b/.test(s) ||
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million)\b/.test(s)
    ) {
      score += 50;
    }
  }

  // ----------------------------------------------------
  // WHY
  // ----------------------------------------------------

  if (info.isWhy) {
    if (
      /\bbecause\b|\bdue to\b|\bso that\b|\bin order to\b|\bcaused by\b|\bresulted from\b|\breason\b|\bwhy\b/.test(s)
    ) {
      score += 70;
    }

    if (
      /\btherefore\b|\bconsequently\b|\bas a result\b/.test(s)
    ) {
      score += 30;
    }
  }

  // ----------------------------------------------------
  // WHAT
  // ----------------------------------------------------

  if (info.isWhat) {
    if (
      /\bis a\b|\bis an\b|\bwas a\b|\bwas an\b|\brefers to\b|\bmeans\b|\bdefined as\b|\bknown as\b/.test(s)
    ) {
      score += 35;
    }
  }

  // ----------------------------------------------------
  // WHICH
  // ----------------------------------------------------

  if (info.isWhich) {
    score += 15;

    if (
      /\bwas\b|\bwere\b|\bis\b|\bare\b|\bchosen\b|\bselected\b|\bused\b/.test(s)
    ) {
      score += 20;
    }
  }

  // ----------------------------------------------------
  // Strong exact-answer patterns
  // ----------------------------------------------------

  if (
    /\bthe first\b|\bthe only\b|\bthe main\b|\bthe cause\b|\bthe reason\b/.test(s)
  ) {
    score += 8;
  }

  // ----------------------------------------------------
  // Penalize navigation / metadata / weak sentences
  // ----------------------------------------------------

  if (
    /\bcookie\b|\bprivacy policy\b|\bsubscribe\b|\bsign up\b|\blog in\b|\badvertisement\b/.test(s)
  ) {
    score -= 80;
  }

  if (
    item.kind === "h1" ||
    item.kind === "h2" ||
    item.kind === "h3"
  ) {
    score += 3;
  }

  return score;
}


// ======================================================
// CANDIDATE SELECTION
// ======================================================

function selectCandidates(
  ranked,
  allSentences,
  info
) {
  const selected = [];
  const selectedIds = new Set();

  // Take the strongest direct candidates.
  for (const item of ranked.slice(0, 30)) {
    if (item.score <= 0) continue;

    addCandidateWithNeighbors(
      item,
      allSentences,
      selected,
      selectedIds
    );

    if (selected.length >= 90) {
      break;
    }
  }

  // If local ranking is weak, still give GPT some page content.
  if (selected.length < 12) {
    for (const item of ranked.slice(0, 20)) {
      addCandidateWithNeighbors(
        item,
        allSentences,
        selected,
        selectedIds
      );

      if (selected.length >= 60) {
        break;
      }
    }
  }

  // Keep deterministic ordering by original page position.
  return selected
    .sort((a, b) => a.id - b.id)
    .slice(0, 100);
}


function addCandidateWithNeighbors(
  item,
  allSentences,
  selected,
  selectedIds
) {
  const position =
    allSentences.findIndex(
      candidate =>
        candidate.id === item.id
    );

  if (position === -1) return;

  const start =
    Math.max(0, position - 1);

  const end =
    Math.min(
      allSentences.length - 1,
      position + 1
    );

  for (
    let i = start;
    i <= end;
    i++
  ) {
    const candidate =
      allSentences[i];

    if (selectedIds.has(candidate.id)) {
      continue;
    }

    selectedIds.add(candidate.id);

    selected.push({
      ...candidate,

      score:
        candidate.id === item.id
          ? item.score
          : scoreNeighbor(candidate)
    });
  }
}


function scoreNeighbor(item) {
  return 1;
}


// ======================================================
// DETERMINISTIC PRECISION CHECK
// ======================================================

function needsPrecisionOverride(
  evidence,
  info
) {
  if (!evidence.length) {
    return true;
  }

  const passage =
    evidence[0].passage.toLowerCase();

  // ----------------------------------------------------
  // Duration
  // ----------------------------------------------------

  if (info.isDuration) {
    if (!hasDuration(passage)) {
      return true;
    }

    if (
      /\ballotted\b|\ballocated\b|\bactivity\b|\bsample collection\b|\bdocumenting\b|\bhalfway\b|\bexperiment\b/.test(passage)
    ) {
      return true;
    }

    if (
      /\bmoon\b|\blunar\b|\bsurface\b/.test(info.raw)
    ) {
      if (
        !/\bsurface\b|\bmoon\b|\blunar stay\b/.test(passage)
      ) {
        return true;
      }
    }
  }

  // ----------------------------------------------------
  // Location
  // ----------------------------------------------------

  if (info.isWhere) {
    if (
      /\bsaw\b.*\blanding site\b/.test(passage) ||
      /\bpassing views\b/.test(passage)
    ) {
      return true;
    }
  }

  // ----------------------------------------------------
  // When
  // ----------------------------------------------------

  if (info.isWhen) {
    if (!hasDateSignal(passage)) {
      return true;
    }
  }

  // ----------------------------------------------------
  // Who
  // ----------------------------------------------------

  if (info.isWho) {
    if (!hasPersonSignal(evidence[0].passage)) {
      return true;
    }

    const genericPeople =
      /\b(?:the\s+)?(?:astronauts?|crew|people|scientists?|researchers?|soldiers?|members?|officials?)\b/i
        .test(evidence[0].passage);

    const explicitIdentity =
      /\b(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married|husband|wife|brother|sister)\b/i
        .test(evidence[0].passage);

    // A generic crew sentence is not enough.
    if (
      genericPeople &&
      !explicitIdentity
    ) {
      return true;
    }

    // Specific lunar-orbit questions need an actual
    // orbit relationship, not merely a person's name.
    if (
      /\b(?:lunar orbit|orbit)\b/i.test(info.raw) &&
      /\b(?:stayed|remained)\b/i.test(info.raw)
    ) {
      if (
        !(
          /\b(?:stayed|remained)\b/i.test(evidence[0].passage) &&
          /\b(?:lunar orbit|orbit)\b/i.test(evidence[0].passage)
        )
      ) {
        return true;
      }
    }
  }

  return false;
}


// ======================================================
// DETERMINISTIC FALLBACK
// ======================================================

function findBestDeterministicSentence(
  question,
  blocks
) {
  const info =
    analyzeQuestion(question);

  const sentences = [];

  for (const block of blocks) {
    for (
      const sentence of
      splitIntoSentences(block.text)
    ) {
      const clean =
        sentence.trim();

      if (!clean) continue;

      sentences.push({
        block_index: block.index,
        passage: clean,
        score: scoreSentence(
          {
            sentence: clean,
            section: block.section || "",
            kind: block.kind || "text"
          },
          info
        )
      });
    }
  }

  if (!sentences.length) {
    return null;
  }

  // Additional deterministic intent-specific scoring.
  for (const item of sentences) {
    // IMPORTANT:
    // Keep the original passage for person detection.
    // Do not pass the lowercased version to hasPersonSignal().
    const original =
      item.passage;

    const s =
      original.toLowerCase();

    // --------------------------------------------------
    // Duration
    // --------------------------------------------------

    if (info.isDuration) {
      if (hasDuration(s)) {
        item.score += 100;
      }

      if (
        /\bon the (?:lunar )?surface\b/.test(s) ||
        /\bon the moon\b/.test(s)
      ) {
        item.score += 90;
      }

      if (
        /\bafter\b.*\bhours?\b.*\bsurface\b/.test(s)
      ) {
        item.score += 100;
      }

      if (
        /\ballotted\b|\ballocated\b|\bsample collection\b|\bdocumenting\b|\bhalfway\b|\bactivity\b|\bexperiment\b/.test(s)
      ) {
        item.score -= 200;
      }
    }

    // --------------------------------------------------
    // Location
    // --------------------------------------------------

    if (info.isWhere) {
      if (
        /\blanding in\b|\blanded in\b|\btouched down\b/.test(s)
      ) {
        item.score += 160;
      }

      if (
        /\bdescended to the surface\b/.test(s)
      ) {
        item.score += 100;
      }

      if (
        /\bsaw\b.*\blanding site\b/.test(s) ||
        /\bpassing views\b/.test(s)
      ) {
        item.score -= 200;
      }
    }

    // --------------------------------------------------
    // WHO
    // --------------------------------------------------

    if (info.isWho) {
      const hasPerson =
        hasPersonSignal(original);

      const genericPeople =
        /\b(?:the\s+)?(?:astronauts?|crew|people|scientists?|researchers?|soldiers?|members?|officials?)\b/i
          .test(original);

      const explicitIdentity =
        /\b(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married|husband|wife|brother|sister)\b/i
          .test(original);

      // Strong person evidence.
      if (hasPerson) {
        item.score += 100;
      }

      // Strong action / relationship evidence.
      if (explicitIdentity) {
        item.score += 70;
      }

      // Exact orbital question pattern.
      if (
        /\b(?:stayed|remained)\b/i.test(original) &&
        /\b(?:lunar orbit|orbit)\b/i.test(original)
      ) {
        item.score += 180;
      }

      // Strong pattern:
      // "Collins remained in lunar orbit..."
      if (
        /\b[A-Z][a-z'-]{2,}\s+(?:stayed|remained)\b/i.test(original) &&
        /\b(?:lunar orbit|orbit)\b/i.test(original)
      ) {
        item.score += 100;
      }

      // First-person achievement patterns.
      if (
        /\bwas the first\b|\bbecame the first\b/.test(s)
      ) {
        item.score += 100;
      }

      // Generic references without identification are weak.
      if (
        genericPeople &&
        !hasPerson
      ) {
        item.score -= 140;
      }

      // Generic crew sentences with no identity/action.
      if (
        genericPeople &&
        !explicitIdentity &&
        !hasPerson
      ) {
        item.score -= 100;
      }
    }

    // --------------------------------------------------
    // When
    // --------------------------------------------------

    if (info.isWhen) {
      if (hasDateSignal(s)) {
        item.score += 100;
      }

      if (
        /\bstarted\b|\bbegan\b|\blaunched\b|\bsank\b|\bended\b|\bended on\b|\barrived\b|\boccurred\b|\btook place\b/.test(s)
      ) {
        item.score += 60;
      }
    }

    // --------------------------------------------------
    // Why
    // --------------------------------------------------

    if (info.isWhy) {
      if (
        /\bbecause\b|\bdue to\b|\bcaused by\b|\bresulted from\b|\breason\b/.test(s)
      ) {
        item.score += 100;
      }
    }
  }

  const sorted =
    sentences
      .filter(item => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score
      );

  if (!sorted.length) {
    return null;
  }

  // Don't return an obviously invalid answer.
  for (const item of sorted) {
    if (
      !needsPrecisionOverride(
        [item],
        info
      )
    ) {
      return {
        block_index:
          item.block_index,

        passage:
          item.passage
      };
    }
  }

  return null;
}


// ======================================================
// SIGNAL HELPERS
// ======================================================

function hasDuration(text) {
  return /\b(?:more than|less than|about|approximately|around|nearly|roughly)?\s*\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\b/i
    .test(String(text || ""));
}


function hasDateSignal(text) {
  const s =
    String(text || "");

  return (
    /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i.test(s) ||

    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?\b/i.test(s) ||

    /\b(?:19|20)\d{2}\b/.test(s) ||

    /\b\d{1,2}:\d{2}\s*(?:UTC|GMT|AM|PM)?\b/i.test(s)
  );
}


function hasLocationSignal(text) {
  const s =
    String(text || "").toLowerCase();

  return (
    /\blanded\b/.test(s) ||
    /\blanding\b/.test(s) ||
    /\btouched down\b/.test(s) ||
    /\bdescended\b/.test(s) ||
    /\barrived\b/.test(s) ||
    /\breached\b/.test(s) ||
    /\bin the\b/.test(s) ||
    /\bat the\b/.test(s)
  );
}


// ======================================================
// PERSON DETECTION
// ======================================================

function hasPersonSignal(text) {
  const s =
    String(text || "");

  // ----------------------------------------------------
  // Explicit titles + names
  // ----------------------------------------------------

  if (
    /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Professor|Captain|Commander|Colonel|General|President)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3}\b/
      .test(s)
  ) {
    return true;
  }

  // ----------------------------------------------------
  // Two-word proper names
  //
  // Examples:
  // Neil Armstrong
  // Marie Curie
  // Edward Smith
  // ----------------------------------------------------

  if (
    /\b[A-Z][a-z'-]+\s+[A-Z][a-z'-]+\b/.test(s)
  ) {
    return true;
  }

  // ----------------------------------------------------
  // Single surname/name directly performing an action
  //
  // Examples:
  // Collins remained...
  // Armstrong walked...
  // Curie discovered...
  // ----------------------------------------------------

  if (
    /\b[A-Z][a-z'-]{2,}\s+(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married)\b/
      .test(s)
  ) {
    return true;
  }

  return false;
}


function containsWord(text, word) {
  if (!word) return false;

  const escaped =
    word.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  return new RegExp(
    `\\b${escaped}\\b`,
    "i"
  ).test(text);
}


// ======================================================
// OPENAI RESPONSES API
// ======================================================

async function callOpenAI(
  apiKey,
  prompt
) {
  const body = {
    model: "gpt-5-mini",

    store: false,

    input: [
      {
        role: "user",

        content: [
          {
            type: "input_text",
            text: prompt
          }
        ]
      }
    ],

    max_output_tokens: 900,

    text: {
      format: {
        type: "json_schema",

        name: "snip_evidence",

        strict: true,

        schema: {
          type: "object",

          properties: {
            evidence: {
              type: "array",

              maxItems: 2,

              items: {
                type: "object",

                properties: {
                  block_index: {
                    type: "integer"
                  },

                  passage: {
                    type: "string"
                  }
                },

                required: [
                  "block_index",
                  "passage"
                ],

                additionalProperties: false
              }
            }
          },

          required: [
            "evidence"
          ],

          additionalProperties: false
        }
      }
    }
  };

  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {
    const response =
      await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },

          body: JSON.stringify(body)
        }
      );

    const text =
      await response.text();

    if (!response.ok) {
      console.error(
        "OpenAI HTTP error:",
        response.status,
        text.slice(0, 2000)
      );

      if (
        response.status === 429 ||
        response.status >= 500
      ) {
        await sleep(
          700 * (attempt + 1)
        );

        continue;
      }

      throw new Error(
        "OpenAI API failed"
      );
    }

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      throw new Error(
        "Invalid OpenAI response"
      );
    }

    const outputText =
      extractOutputText(data);

    if (
      outputText &&
      outputText.trim()
    ) {
      return outputText;
    }

    console.error(
      "Empty OpenAI response:",
      JSON.stringify(data).slice(
        0,
        4000
      )
    );

    await sleep(
      500 * (attempt + 1)
    );
  }

  throw new Error(
    "Empty OpenAI response"
  );
}


// ======================================================
// EXTRACT RESPONSE TEXT
// ======================================================

function extractOutputText(data) {
  if (
    typeof data?.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text;
  }

  const parts = [];

  for (
    const output of data?.output || []
  ) {
    for (
      const content of output?.content || []
    ) {
      if (
        typeof content?.text === "string" &&
        content.text.trim()
      ) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}


// ======================================================
// PARSE MODEL JSON
// ======================================================

function parseModelJSON(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const match =
    String(text || "")
      .match(/\{[\s\S]*\}/);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(
      match[0]
    );
  } catch {
    return null;
  }
}


// ======================================================
// SENTENCE SPLITTING
// ======================================================

function splitIntoSentences(text) {
  const normalized =
    String(text || "")
      .replace(/\s+/g, " ")
      .trim();

  if (!normalized) {
    return [];
  }

  const matches =
    normalized.match(
      /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g
    );

  return matches || [normalized];
}


// ======================================================
// TEXT NORMALIZATION
// ======================================================

function normalizeText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(
      /[“”„‟]/g,
      '"'
    )
    .replace(
      /[‘’‚‛]/g,
      "'"
    )
    .replace(
      /\u00a0/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .toLowerCase();
}


function containsEquivalentText(
  source,
  passage
) {
  const a =
    normalizeText(source);

  const b =
    normalizeText(passage);

  if (!a || !b) {
    return false;
  }

  if (a.includes(b)) {
    return true;
  }

  const compactA =
    a.replace(
      /[^\p{L}\p{N}]+/gu,
      ""
    );

  const compactB =
    b.replace(
      /[^\p{L}\p{N}]+/gu,
      ""
    );

  return compactA.includes(
    compactB
  );
}


// ======================================================
// UTILITY
// ======================================================

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}
