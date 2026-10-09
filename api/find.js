const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGIN = "*";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const question = String(req.body?.question || "").trim();
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    if (!blocks.length) {
      return res.status(400).json({ error: "No page content supplied" });
    }

    const cleanBlocks = blocks
      .map((block, index) => ({
        index: Number.isFinite(Number(block?.index))
          ? Number(block.index)
          : index,
        id: block?.id || `block-${index}`,
        text: String(block?.text || "").replace(/\s+/g, " ").trim(),
        section: String(block?.section || "Page").replace(/\s+/g, " ").trim(),
        page:
          block?.page !== null &&
          block?.page !== undefined &&
          block?.page !== "" &&
          Number.isFinite(Number(block.page)) &&
          Number(block.page) >= 1
            ? Number(block.page)
            : null
      }))
      .filter(block => block.text.length >= 15);

    if (!cleanBlocks.length) {
      return res.status(400).json({ error: "No usable page content supplied" });
    }

    const info = analyzeQuestion(question);

    // SENTENCE EXTRACTION
    const sentenceItems = [];

    for (const block of cleanBlocks) {
      const sentences = splitIntoSentences(block.text);

      sentences.forEach((sentence, sentenceIndex) => {
        const cleaned = sentence.replace(/\s+/g, " ").trim();
        if (!cleaned) return;

        sentenceItems.push({
          block_index: block.index,
          block_id: block.id,
          section: block.section,
          page: block.page,
          sentence_index: sentenceIndex,
          sentence: cleaned
        });
      });
    }

    // LOCAL RANKING
    const ranked = sentenceItems
      .map(item => ({ ...item, score: scoreSentence(item, info) }))
      .sort((a, b) => b.score - a.score);

    // BUILD MODEL CANDIDATES
    const candidateMap = new Map();

    for (const item of ranked.slice(0, 60)) {
      candidateMap.set(`${item.block_index}:${item.sentence_index}`, item);

      const neighbors = sentenceItems.filter(candidate =>
        candidate.block_index === item.block_index &&
        Math.abs(candidate.sentence_index - item.sentence_index) <= 1
      );

      for (const neighbor of neighbors) {
        candidateMap.set(
          `${neighbor.block_index}:${neighbor.sentence_index}`,
          neighbor
        );
      }
    }

    let candidates = [...candidateMap.values()].sort((a, b) =>
      a.block_index !== b.block_index
        ? a.block_index - b.block_index
        : a.sentence_index - b.sentence_index
    );

    const candidateTextParts = [];
    const includedCandidateKeys = new Set();
    let totalChars = 0;

    for (const item of candidates) {
      const line =
        `[block ${item.block_index} | page: ${item.page ?? "-"} | section: ${item.section}]\n${item.sentence}\n`;

      if (totalChars + line.length > 30000) break;

      candidateTextParts.push(line);
      totalChars += line.length;
      includedCandidateKeys.add(`${item.block_index}:${item.sentence_index}`);
    }

    candidates = candidates.filter(item =>
      includedCandidateKeys.has(`${item.block_index}:${item.sentence_index}`)
    );

    if (!candidates.length) {
      return res.status(200).json({ evidence: [] });
    }

    // OPENAI VERIFICATION
    let modelResult = null;

    try {
      modelResult = await callOpenAI({ question, info, candidates });
    } catch (error) {
      console.error("OpenAI verification failed:", error?.message || error);
    }

    // VALIDATE MODEL RESULT
    let evidence = [];

    if (modelResult) {
      evidence = normalizeModelEvidence(modelResult, candidates, cleanBlocks);
    }

    // DETERMINISTIC FALLBACK
    if (!evidence.length) {
      const best = findBestDeterministicSentence(ranked, info);

      if (best) {
        evidence = [{
          block_index: best.block_index,
          block_id: best.block_id,
          passage: best.sentence,
          section: best.section,
          page: best.page ?? null
        }];
      }
    }

    // FINAL VALIDATION
    if (evidence.length) {
      evidence = dedupeEvidence(evidence);

      if (shouldUseDeterministicOverride(evidence, info)) {
        const best = findBestDeterministicSentence(ranked, info);

        if (best) {
          evidence = [{
            block_index: best.block_index,
            block_id: best.block_id,
            passage: best.sentence,
            section: best.section,
            page: best.page ?? null
          }];
        } else {
          // Never return evidence that failed final validation.
          evidence = [];
        }
      }
    }

    return res.status(200).json({ evidence });
  } catch (error) {
    console.error("SNIP API ERROR:", error?.stack || error);

    return res.status(500).json({
      error: error?.message || "Internal server error"
    });
  }
}


/* ============================================================
   QUESTION ANALYSIS
   ============================================================ */

function analyzeQuestion(question) {
  const q = String(question || "").toLowerCase().replace(/\s+/g, " ").trim();

  return {
    raw: q,
    isWho: /\bwho\b/.test(q),
    isWhen: /\bwhen\b/.test(q) || /\bwhat date\b/.test(q) || /\bwhat time\b/.test(q),
    isWhere: /\bwhere\b/.test(q) || /\bwhat location\b/.test(q) || /\bwhich location\b/.test(q),
    isDuration:
      /\bhow long\b/.test(q) ||
      /\bhow many\s+(?:hours?|minutes?|days?|weeks?|months?|years?)\b/.test(q) ||
      /\bwhat was the duration\b/.test(q),
    isHowMany: /\bhow many\b/.test(q) || /\bhow much\b/.test(q),
    isWhy: /\bwhy\b/.test(q) || /\bwhat caused\b/.test(q) || /\bwhat was the cause\b/.test(q),
    isWhat: /^\s*what\b/.test(q),
    isWhich: /\bwhich\b/.test(q),
    isRelationship: /\b(?:husband|wife|father|mother|son|daughter|brother|sister|partner|spouse)\b/.test(q),
    terms: extractQuestionTerms(q)
  };
}


/* ============================================================
   QUESTION TERMS
   ============================================================ */

function extractQuestionTerms(question) {
  const stopWords = new Set([
    "who", "what", "when", "where", "why", "which", "how", "long",
    "many", "much", "was", "were", "is", "are", "did", "does", "do",
    "the", "a", "an", "of", "to", "in", "on", "for", "from", "with",
    "and", "or", "by", "during", "about", "that", "this", "it", "its",
    "their", "his", "her", "they", "them", "he", "she"
  ]);

  return question
    .split(/\W+/)
    .map(word => word.trim())
    .filter(Boolean)
    .filter(word => word.length >= 3)
    .filter(word => !stopWords.has(word));
}


/* ============================================================
   SENTENCE SPLITTER
   ============================================================ */

function splitIntoSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(])/g)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}


/* ============================================================
   SENTENCE SCORING
   ============================================================ */

function scoreSentence(item, info) {
  const sentence = String(item.sentence || "");
  const s = sentence.toLowerCase();
  let score = 0;

  for (const term of info.terms) {
    if (s.includes(term)) score += 12;
  }

  const questionWords = info.terms.filter(word => word.length >= 4);

  if (
    questionWords.length >= 2 &&
    questionWords.every(word => s.includes(word))
  ) {
    score += 35;
  }

  // WHO
  if (info.isWho) {
    const hasPerson = hasPersonSignal(sentence);

    const genericPeople =
      /\b(?:the\s+)?(?:astronauts?|crew|people|scientists?|researchers?|soldiers?|members?|officials?)\b/i.test(sentence);

    const explicitIdentity =
      /\b(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married|husband|wife|brother|sister|father|mother|son|daughter|partner|spouse)\b/i.test(sentence);

    if (
      /\b(?:stayed|remained)\b/i.test(sentence) &&
      /\b(?:lunar orbit|orbit)\b/i.test(sentence)
    ) score += 180;

    if (hasPerson && explicitIdentity) score += 100;
    if (hasPerson) score += 45;
    if (explicitIdentity) score += 30;

    if (genericPeople && !hasPerson) score -= 100;
    if (genericPeople && !explicitIdentity && !hasPerson) score -= 80;

    if (info.isRelationship) {
      const relationshipWord =
        /\b(?:husband|wife|spouse|father|mother|son|daughter|brother|sister|partner)\b/i.test(sentence);

      const explicitRelationship =
        /\b(?:married|husband|wife|spouse|father|mother|son|daughter|brother|sister|partner)\b/i.test(sentence);

      if (explicitRelationship) score += 60;

      if (/\b(?:married|married to|was married to|were married)\b/i.test(sentence)) {
        score += 160;
      }

      if (/\b[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3}'s\s+(?:husband|wife|spouse)\b/.test(sentence)) {
        score += 140;
      }

      if (/\b(?:husband|wife|spouse)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,2}\b/.test(sentence)) {
        score += 100;
      }

      if (/\b(?:her|his|their)\s+(?:husband|wife|spouse)\b/i.test(sentence)) {
        score -= 220;
      }

      if (/\bwith\s+(?:her|his|their)\s+(?:husband|wife|spouse)\b/i.test(sentence)) {
        score -= 250;
      }

      if (relationshipWord && /[\(\[]/.test(sentence)) score -= 100;

      if (
        /\b(?:her|his|their)\s+(?:husband|wife|spouse)\b/i.test(sentence) &&
        !/\b(?:married|married to)\b/i.test(sentence)
      ) score -= 180;
    }
  }

  // WHEN
  if (info.isWhen) {
    const hasYear = /\b(?:18|19|20)\d{2}\b/.test(sentence);

    const hasMonth =
      /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(sentence);

    const hasDay =
      /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(sentence);

    const hasTime =
      /\b\d{1,2}:\d{2}\b/.test(sentence) ||
      /\b(?:utc|gmt|est|edt|pst|pdt)\b/i.test(sentence);

    const hasDate = hasYear || hasMonth || hasDay || hasTime;

    if (hasDate) score += 80;

    const eventConnection =
      /\b(?:occurred|happened|took place|began|started|ended|launched|landed|arrived|departed|born|died|married|won|received|awarded|was awarded|was born|was launched)\b/i.test(sentence);

    if (eventConnection) score += 90;

    const isAwardQuestion =
      /\b(?:nobel|prize|award|awarded|won|received)\b/i.test(info.raw);

    const hasAwardWord =
      /\b(?:nobel|prize|award|awarded|won|received)\b/i.test(sentence);

    const hasAwardAction =
      /\b(?:won|win|received|awarded|was awarded|were awarded|shared|was given|were given)\b/i.test(sentence);

    if (hasAwardWord) score += 70;

    if (isAwardQuestion && hasDate && hasAwardWord && hasAwardAction) {
      score += 220;
    }

    const importantWhenTerms = info.terms.filter(term =>
      term.length >= 4 &&
      !["when", "what", "date", "time"].includes(term)
    );

    const matchingWhenTerms =
      importantWhenTerms.filter(term => s.includes(term)).length;

    if (matchingWhenTerms >= 1) score += 35;
    if (matchingWhenTerms >= 2) score += 70;
    if (matchingWhenTerms >= 3) score += 110;

    if (
      isAwardQuestion &&
      hasDate &&
      hasAwardAction &&
      matchingWhenTerms >= 2
    ) score += 180;

    if (hasDate && /\b(?:in|on|during|after|before)\b/i.test(sentence)) {
      score += 20;
    }

    if (
      hasDate &&
      /\b(?:researches|services|phenomena|career|history|later|earlier)\b/i.test(sentence) &&
      !eventConnection
    ) score -= 70;

    if (isAwardQuestion && hasAwardWord && !hasAwardAction) {
      score -= 140;
    }
  }

  // WHERE
  if (info.isWhere) {
    if (/\b(?:in|at|on|near|inside|outside|aboard|from|into|onto)\b/i.test(sentence)) score += 25;

    if (/\b(?:located|landed|launched|arrived|departed|traveled|travelled|based|situated|occurred)\b/i.test(sentence)) {
      score += 70;
    }

    if (/\b(?:Moon|Earth|Mars|Atlantic|Pacific|London|Paris|New York|Washington|Dubai|Addis Ababa)\b/.test(sentence)) {
      score += 30;
    }
  }

  // DURATION
  if (info.isDuration) {
    if (/\b\d+(?:\.\d+)?\s*(?:hours?|minutes?|days?|weeks?|months?|years?)\b/i.test(sentence)) score += 150;

    if (/\b(?:more than|less than|approximately|about|nearly|roughly)\s+\d+/i.test(sentence)) score += 40;

    if (/\b(?:lasted|duration|spent|remained|stayed|on the surface|aboard)\b/i.test(sentence)) score += 60;
  }

  // HOW MANY / HOW MUCH
  if (info.isHowMany) {
    if (/\b\d+(?:\.\d+)?\b/.test(sentence)) score += 80;
    if (/\b(?:million|billion|thousand|hundred|percent|%)\b/i.test(sentence)) score += 60;
  }

  // WHY
  if (info.isWhy) {
    const hasCauseLanguage =
      /\b(?:because|due to|since|as a result of|reason|caused by|caused|cause|causes|resulted from|resulting from|triggered|contributed to|contributing to|led to|stemmed from|arose from|driven by|in response to)\b/i.test(sentence);

    if (hasCauseLanguage) score += 100;

    const relevantTerms = info.terms.filter(term => term.length >= 4);
    const matchingTerms = relevantTerms.filter(term => s.includes(term)).length;

    if (matchingTerms >= 1) score += 45;
    if (matchingTerms >= 2) score += 80;
    if (matchingTerms >= 3) score += 120;

    if (/\b(?:one of the main causes|major cause|primary cause|main cause|key factor|major factor|primary factor|important factor|factors included|factors were|was caused by|were caused by)\b/i.test(sentence)) {
      score += 100;
    }

    if (
      /\b(?:the\s+)?(?:great depression|depression)\b/i.test(sentence) &&
      /\b(?:caused by|cause of|causes included|caused|resulted from|stemmed from|triggered by|factors included)\b/i.test(sentence)
    ) score += 150;

    if (
      /\b(?:recovery|stagnation|decline|aftermath|consequence|resulting economy|economic recovery)\b/i.test(sentence) &&
      !/\b(?:cause|caused|because|due to|factor|triggered|resulted from|stemmed from)\b/i.test(sentence)
    ) score -= 50;

    if (
      /\b(?:led to|resulted in|caused)\b/i.test(sentence) &&
      !/\b(?:caused by|resulted from|stemmed from|because|due to|factor|cause of)\b/i.test(sentence)
    ) score -= 35;
  }

  // WHAT / WHICH
  if (info.isWhat && /\b(?:is|was|means|refers to|defined as|known as|called)\b/i.test(sentence)) {
    score += 50;
  }

  if (info.isWhich && info.terms.some(term => s.includes(term))) {
    score += 35;
  }

  // NOISE PENALTIES
  if (/\b(?:copyright|privacy policy|terms of service|cookie policy|sign in|subscribe|menu|navigation)\b/i.test(sentence)) {
    score -= 100;
  }

  if (/^\s*[\[\(]?\d+[\]\)]?\s*$/.test(sentence)) score -= 100;

  return score;
}


/* ============================================================
   PERSON DETECTION
   ============================================================ */

function hasPersonSignal(text) {
  const s = String(text || "");

  if (/\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Professor|Captain|Commander|Colonel|General|President)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3}\b/.test(s)) {
    return true;
  }

  if (/\b[A-Z][a-z'-]+\s+[A-Z][a-z'-]+\b/.test(s)) return true;

  if (/\b[A-Z][a-z'-]{2,}\s+(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married)\b/.test(s)) {
    return true;
  }

  return false;
}


/* ============================================================
   EXPLICIT RELATIONSHIP IDENTITY
   ============================================================ */

function hasExplicitRelationshipIdentity(sentence, info) {
  const text = String(sentence || "");

  if (/\b[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}\s+(?:married|was married to|were married to)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}\b/.test(text)) {
    return true;
  }

  if (/\b[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}\s+(?:was|were)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}'s\s+(?:husband|wife|spouse)\b/.test(text)) {
    return true;
  }

  if (/\b[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}'s\s+(?:husband|wife|spouse)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}\b/.test(text)) {
    return true;
  }

  if (/\b(?:husband|wife|spouse)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}\b/.test(text)) {
    return true;
  }

  if (/\b(?:father|mother|son|daughter|brother|sister|partner)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}\b/.test(text)) {
    return true;
  }

  if (/\b(?:her|his|their)\s+(?:husband|wife|spouse)\b/i.test(text)) {
    return false;
  }

  return false;
}


/* ============================================================
   DETERMINISTIC FALLBACK
   ============================================================ */

function findBestDeterministicSentence(ranked, info) {
  if (!ranked.length) return null;

  const scored = ranked.map(item => ({ ...item, score: item.score }));

  // WHO
  if (info.isWho) {
    for (const item of scored) {
      const original = String(item.sentence || "");
      const s = original.toLowerCase();
      const hasPerson = hasPersonSignal(original);

      const genericPeople =
        /\b(?:the\s+)?(?:astronauts?|crew|people|scientists?|researchers?|soldiers?|members?|officials?)\b/i.test(original);

      const explicitIdentity =
        /\b(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married|husband|wife|brother|sister|father|mother|son|daughter|partner|spouse)\b/i.test(original);

      if (hasPerson) item.score += 100;
      if (explicitIdentity) item.score += 70;

      if (/\b(?:stayed|remained)\b/i.test(original) && /\b(?:lunar orbit|orbit)\b/i.test(original)) {
        item.score += 180;
      }

      if (/\b[A-Z][a-z'-]{2,}\s+(?:stayed|remained)\b/i.test(original) && /\b(?:lunar orbit|orbit)\b/i.test(original)) {
        item.score += 100;
      }

      if (/\bwas the first\b|\bbecame the first\b/.test(s)) item.score += 100;
      if (genericPeople && !hasPerson) item.score -= 140;
      if (genericPeople && !explicitIdentity && !hasPerson) item.score -= 100;

      if (info.isRelationship) {
        const explicitRelationship = hasExplicitRelationshipIdentity(original, info);

        if (explicitRelationship) item.score += 350;
        else item.score -= 150;

        if (/\b(?:married|was married to|were married to)\b/i.test(original)) item.score += 220;
        if (/\b(?:was|were)\b.*\b(?:husband|wife|spouse)\b/i.test(original)) item.score += 180;

        if (/\b(?:husband|wife|spouse)\s+[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){0,3}\b/.test(original)) {
          item.score += 150;
        }

        if (/\b(?:her|his|their)\s+(?:husband|wife|spouse)\b/i.test(original)) item.score -= 400;
        if (/\bwith\s+(?:her|his|their)\s+(?:husband|wife|spouse)\b/i.test(original)) item.score -= 450;

        if (/[\(\[]/.test(original) && /\b(?:husband|wife|spouse)\b/i.test(original)) {
          item.score -= 180;
        }
      }
    }
  }

  // WHEN
  if (info.isWhen) {
    const isAwardQuestion = /\b(?:nobel|prize|award|awarded|won|received)\b/i.test(info.raw);

    for (const item of scored) {
      const original = String(item.sentence || "");
      const s = original.toLowerCase();

      const hasYear = /\b(?:18|19|20)\d{2}\b/.test(original);
      const hasMonth = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(original);
      const hasDay = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(original);
      const hasTime = /\b\d{1,2}:\d{2}\b/.test(original) || /\b(?:utc|gmt|est|edt|pst|pdt)\b/i.test(original);
      const hasDate = hasYear || hasMonth || hasDay || hasTime;

      if (hasDate) item.score += 80;

      const eventConnection =
        /\b(?:launch|launched|landed|began|started|ended|occurred|happened|took place|born|died|married|won|win|received|awarded|was awarded|were awarded|arrived|departed|shared|was given|were given)\b/i.test(s);

      if (eventConnection) item.score += 90;

      const hasAwardWord = /\b(?:nobel|prize|award|awarded|won|received)\b/i.test(s);
      const hasAwardAction = /\b(?:won|win|received|awarded|was awarded|were awarded|shared|was given|were given)\b/i.test(s);

      if (hasAwardWord) item.score += 70;

      if (isAwardQuestion && hasDate && hasAwardWord && hasAwardAction) {
        item.score += 220;
      }

      const importantWhenTerms = info.terms.filter(term =>
        term.length >= 4 && !["when", "what", "date", "time"].includes(term)
      );

      const matchingWhenTerms = importantWhenTerms.filter(term => s.includes(term)).length;

      if (matchingWhenTerms >= 1) item.score += 35;
      if (matchingWhenTerms >= 2) item.score += 70;
      if (matchingWhenTerms >= 3) item.score += 110;

      if (isAwardQuestion && hasDate && hasAwardAction && matchingWhenTerms >= 2) {
        item.score += 180;
      }

      if (hasDate && /\b(?:researches|services|phenomena|career|history|later|earlier)\b/i.test(s) && !eventConnection) {
        item.score -= 70;
      }

      if (isAwardQuestion && hasAwardWord && !hasAwardAction) item.score -= 140;
    }

    // For award-date questions, only return a candidate with a date,
    // an explicit award action, and relevant question terms.
    if (isAwardQuestion) {
      const strictAwardCandidates = scored.filter(item => {
        const text = String(item.sentence || "");
        const lower = text.toLowerCase();

        const hasDate =
          /\b(?:18|19|20)\d{2}\b/.test(text) ||
          /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text) ||
          /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text) ||
          /\b\d{1,2}:\d{2}\b/.test(text);

        const hasAwardWord = /\b(?:nobel|prize|award)\b/i.test(text);
        const hasAwardAction = /\b(?:won|win|received|awarded|was awarded|were awarded|shared|was given|were given)\b/i.test(text);

        const importantTerms = info.terms.filter(term =>
          term.length >= 4 && !["when", "what", "date", "time"].includes(term)
        );

        const matchedTerms = importantTerms.filter(term => lower.includes(term)).length;

        return hasDate &&
          hasAwardWord &&
          hasAwardAction &&
          (importantTerms.length < 2 || matchedTerms >= 2);
      });

      // Do not fall back to an unrelated date/citation sentence.
      if (!strictAwardCandidates.length) return null;

      strictAwardCandidates.sort((a, b) => b.score - a.score);
      return strictAwardCandidates[0];
    }
  }

  // WHERE
  if (info.isWhere) {
    for (const item of scored) {
      const s = item.sentence.toLowerCase();

      if (/\b(?:landed|located|situated|occurred|arrived|departed|traveled|travelled|based)\b/i.test(s)) {
        item.score += 100;
      }

      if (/\b(?:in|at|on|near|inside|outside|aboard)\b/i.test(s)) item.score += 20;
    }
  }

  // DURATION
  if (info.isDuration) {
    for (const item of scored) {
      const s = item.sentence.toLowerCase();

      if (/\b\d+(?:\.\d+)?\s*(?:hours?|minutes?|days?|weeks?|months?|years?)\b/i.test(s)) item.score += 160;
      if (/\b(?:more than|less than|approximately|about|nearly|roughly)\s+\d+/i.test(s)) item.score += 40;
      if (/\b(?:lasted|duration|spent|remained|stayed)\b/i.test(s)) item.score += 60;
    }
  }

  // HOW MANY
  if (info.isHowMany) {
    for (const item of scored) {
      if (/\b\d+(?:\.\d+)?\b/.test(item.sentence)) item.score += 80;
    }
  }

  // WHY
  if (info.isWhy) {
    for (const item of scored) {
      const s = item.sentence.toLowerCase();
      const relevantTerms = info.terms.filter(term => term.length >= 4);
      const matchingTerms = relevantTerms.filter(term => s.includes(term)).length;

      if (matchingTerms >= 1) item.score += 45;
      if (matchingTerms >= 2) item.score += 80;
      if (matchingTerms >= 3) item.score += 120;

      if (/\b(?:because|due to|since|as a result of|caused by|caused|cause|causes|resulted from|resulting from|triggered|contributed to|contributing to|stemmed from|arose from|driven by)\b/i.test(s)) {
        item.score += 120;
      }

      if (/\b(?:one of the main causes|major cause|primary cause|main cause|key factor|major factor|primary factor|important factor|factors included|factors were|was caused by|were caused by)\b/i.test(s)) {
        item.score += 120;
      }

      if (/\b(?:great depression|depression)\b/i.test(s) && /\b(?:caused by|causes included|caused|resulted from|stemmed from|triggered by|factors included)\b/i.test(s)) {
        item.score += 180;
      }

      if (/\b(?:recovery|stagnation|decline|aftermath|consequence|resulting economy|economic recovery)\b/i.test(s) &&
          !/\b(?:cause|caused|because|due to|factor|triggered|resulted from|stemmed from)\b/i.test(s)) {
        item.score -= 80;
      }

      if (/\b(?:led to|resulted in|caused)\b/i.test(s) &&
          !/\b(?:caused by|resulted from|stemmed from|because|due to|factor|cause of)\b/i.test(s)) {
        item.score -= 35;
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}


/* ============================================================
   OPENAI
   ============================================================ */

async function callOpenAI({ question, info, candidates }) {
  const candidateText = candidates
    .map((item, index) =>
      `CANDIDATE ${index + 1}\nBlock: ${item.block_index}\nPage: ${item.page ?? "-"}\nSection: ${item.section}\nText: ${item.sentence}`
    )
    .join("\n\n");

  const systemPrompt = `
You are the answer-location engine for Snip.

Snip does NOT want a general answer. Identify the exact passage in the supplied page or document that answers the user's question. Return only evidence from the supplied text.

Rules:
1. Never invent information or answer from outside knowledge.
2. Select the smallest passage that directly answers the question.
3. Prefer a sentence that explicitly establishes the answer.
4. Do not select navigation, menus, unrelated metadata, or citation fragments.
5. The passage must actually support the question.
6. The user will be taken directly to the selected passage.
7. Preserve the original wording exactly.
8. Page numbers are metadata; do not include them in passage text.

WHO:
- Find the sentence that explicitly identifies the requested person.
- Do not select a generic sentence about a group.
- For relationship questions, explicitly identify the person. "Her husband" alone is not enough; prefer "Marie Curie married Pierre Curie in 1895" or "Pierre Curie was Marie Curie's husband."
- Never infer identity from a pronoun.

WHEN:
- Find the date/time for the specific event asked about.
- A date alone is not enough; it must be connected to the event.
- For award questions, the selected sentence must contain a date and explicitly connect that date to the award/prize with an award action, such as "In 1903, Marie Curie was awarded..." or "Marie Curie won the Nobel Prize in 1903."
- Do not select generic award-citation wording about services, research, or phenomena unless it explicitly establishes when the award was won.
- If no candidate directly establishes the date, return an empty evidence array.

WHERE:
- Find the sentence explicitly identifying the location.

HOW LONG:
- Find the sentence containing the relevant duration; prefer explicit numerical durations.

HOW MANY / HOW MUCH:
- Find the sentence containing the relevant quantity.

WHY:
- Find the actual reason or cause.
- Prefer explicit causal wording such as "X was caused by Y", "The main cause was Y", or "Factors included Y".
- Do not select a downstream consequence as the cause.
- For "What caused X?", "X led to Y" does not answer unless it also identifies what caused X.
- If multiple factors caused the event, select the passage identifying those factors.

WHAT:
- Find the sentence that directly defines or explains the requested thing.

If no candidate directly answers the question, return an empty evidence array.
`;

  const userPrompt = `
Question:
${question}

Question type:
${JSON.stringify({
    isWho: info.isWho,
    isWhen: info.isWhen,
    isWhere: info.isWhere,
    isDuration: info.isDuration,
    isHowMany: info.isHowMany,
    isWhy: info.isWhy,
    isWhat: info.isWhat,
    isWhich: info.isWhich,
    isRelationship: info.isRelationship
  })}

Page/document candidates:
${candidateText}
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }]
        }
      ],
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
                items: {
                  type: "object",
                  properties: {
                    block_index: { type: "integer" },
                    passage: { type: "string" }
                  },
                  required: ["block_index", "passage"],
                  additionalProperties: false
                }
              }
            },
            required: ["evidence"],
            additionalProperties: false
          }
        }
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const outputText = extractResponseText(data);

  if (!outputText) throw new Error("Empty OpenAI response");

  return parseJsonSafely(outputText);
}


/* ============================================================
   RESPONSE TEXT
   ============================================================ */

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = [];

  for (const item of output) {
    if (!Array.isArray(item?.content)) continue;

    for (const content of item.content) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }

  return parts.join("\n").trim();
}


/* ============================================================
   JSON PARSER
   ============================================================ */

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    throw new Error("Could not parse OpenAI JSON response");
  }
}


/* ============================================================
   MODEL EVIDENCE VALIDATION
   ============================================================ */

function normalizeModelEvidence(modelResult, candidates, cleanBlocks) {
  const rawEvidence = Array.isArray(modelResult?.evidence) ? modelResult.evidence : [];
  const result = [];

  for (const item of rawEvidence) {
    const blockIndex = Number(item?.block_index);
    const passage = String(item?.passage || "").replace(/\s+/g, " ").trim();

    if (!Number.isFinite(blockIndex) || !passage) continue;

    const candidate = candidates.find(c =>
      c.block_index === blockIndex && textEquivalent(c.sentence, passage)
    );

    if (!candidate) {
      const candidateByBlock = candidates.find(c => c.block_index === blockIndex);

      if (!candidateByBlock) continue;

      if (!containsEquivalentText(candidateByBlock.sentence, passage)) continue;
    }

    const block = cleanBlocks.find(b => b.index === blockIndex);

    result.push({
      block_index: blockIndex,
      block_id: block?.id || `block-${blockIndex}`,
      passage,
      section: block?.section || "Page",
      page: block?.page ?? null
    });
  }

  return result;
}


/* ============================================================
   TEXT NORMALIZATION
   ============================================================ */

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function textEquivalent(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  return x === y || x.includes(y) || y.includes(x);
}

function containsEquivalentText(source, target) {
  const x = normalizeText(source);
  const y = normalizeText(target);
  return x.includes(y) || y.includes(x);
}


/* ============================================================
   DEDUPE
   ============================================================ */

function dedupeEvidence(evidence) {
  const seen = new Set();
  const result = [];

  for (const item of evidence) {
    const key = `${item.block_index}:${normalizeText(item.passage)}`;

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(item);
  }

  return result;
}


/* ============================================================
   FINAL DETERMINISTIC OVERRIDE
   ============================================================ */

function shouldUseDeterministicOverride(evidence, info) {
  if (!evidence.length) return true;

  const passage = String(evidence[0].passage || "");

  // WHO
  if (info.isWho) {
    if (!hasPersonSignal(passage)) return true;

    const genericPeople =
      /\b(?:the\s+)?(?:astronauts?|crew|people|scientists?|researchers?|soldiers?|members?|officials?)\b/i.test(passage);

    const explicitIdentity =
      /\b(?:was|were|became|remained|stayed|served|led|commanded|piloted|flew|walked|landed|discovered|invented|married|husband|wife|brother|sister|father|mother|son|daughter|partner|spouse)\b/i.test(passage);

    if (genericPeople && !explicitIdentity) return true;

    if (/\b(?:lunar orbit|orbit)\b/i.test(info.raw) && /\b(?:stayed|remained)\b/i.test(info.raw)) {
      if (!(/\b(?:stayed|remained)\b/i.test(passage) && /\b(?:lunar orbit|orbit)\b/i.test(passage))) {
        return true;
      }
    }

    if (info.isRelationship) {
      if (/\b(?:her|his|their)\s+(?:husband|wife|spouse)\b/i.test(passage)) return true;

      if (!hasExplicitRelationshipIdentity(passage, info)) return true;

      if (/[\(\[]/.test(passage) &&
          /\b(?:husband|wife|spouse)\b/i.test(passage) &&
          !/\b(?:married|was married|were married)\b/i.test(passage)) {
        return true;
      }
    }
  }

  // DURATION
  if (info.isDuration &&
      !/\b\d+(?:\.\d+)?\s*(?:hours?|minutes?|days?|weeks?|months?|years?)\b/i.test(passage)) {
    return true;
  }

  // WHEN
  if (info.isWhen) {
    const lower = passage.toLowerCase();

    const hasDate =
      /\b(?:18|19|20)\d{2}\b/.test(passage) ||
      /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(passage) ||
      /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(passage) ||
      /\b\d{1,2}:\d{2}\b/.test(passage) ||
      /\b(?:utc|gmt|est|edt|pst|pdt)\b/i.test(passage);

    if (!hasDate) return true;

    const isAwardQuestion = /\b(?:nobel|prize|award|awarded|won|received)\b/i.test(info.raw);

    if (isAwardQuestion) {
      const hasAwardWord = /\b(?:nobel|prize|award)\b/i.test(lower);

      const hasAwardAction =
        /\b(?:won|win|received|awarded|was awarded|were awarded|shared|was given|were given)\b/i.test(lower);

      if (!hasAwardWord || !hasAwardAction) return true;

      const importantTerms = info.terms.filter(term =>
        term.length >= 4 && !["when", "what", "date", "time"].includes(term)
      );

      const matchedTerms = importantTerms.filter(term => lower.includes(term)).length;

      if (importantTerms.length >= 2 && matchedTerms < 2) return true;
    }

    const eventConnection =
      /\b(?:occurred|happened|took place|began|started|ended|launched|landed|arrived|departed|born|died|married|won|win|received|awarded|was awarded|were awarded|was born|was launched|shared|was given|were given)\b/i.test(passage);

    if (!eventConnection) {
      const questionTerms = info.terms.filter(term => term.length >= 4);
      const matchedTerms = questionTerms.filter(term => lower.includes(term)).length;

      if (matchedTerms < 2) return true;
    }

    if (/\b(?:researches|services|phenomena|career|history|later|earlier)\b/i.test(lower) && !eventConnection) {
      return true;
    }
  }

  // WHY
  if (info.isWhy) {
    const lower = passage.toLowerCase();
    const relevantTerms = info.terms.filter(term => term.length >= 4);
    const matchingTerms = relevantTerms.filter(term => lower.includes(term)).length;

    const hasCauseLanguage =
      /\b(?:because|due to|since|as a result of|reason|caused by|caused|cause|causes|resulted from|resulting from|triggered|contributed to|contributing to|led to|stemmed from|arose from|driven by|in response to)\b/i.test(passage);

    if (!hasCauseLanguage && matchingTerms < 2) return true;

    if (/\b(?:recovery|stagnation|decline|aftermath|consequence|resulting economy|economic recovery)\b/i.test(passage) &&
        !/\b(?:cause|caused|because|due to|factor|triggered|resulted from|stemmed from)\b/i.test(passage)) {
      return true;
    }

    if (/\b(?:led to|resulted in|caused)\b/i.test(passage) &&
        !/\b(?:caused by|resulted from|stemmed from|because|due to|factor|cause of)\b/i.test(passage) &&
        matchingTerms < 3) {
      return true;
    }
  }

  // WHERE
  if (info.isWhere &&
      !/\b(?:in|at|on|near|inside|outside|aboard|located|landed|arrived|departed|situated)\b/i.test(passage)) {
    return true;
  }

  return false;
}
