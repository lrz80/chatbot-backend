// src/lib/channels/engine/lang/resolveTurnLang.ts

import type { Pool } from "pg";
import type { Lang } from "../clients/clientDb";

type DetectIdiomaResult = {
  lang: Lang | null;
  confidence: number;
  source: "heuristic" | "openai" | "none";
};

type ResolveArgs = {
  pool: Pool;

  tenantId: string;
  canal: string;
  contacto: string;

  userInput: string;

  tenantBase: Lang;
  storedLang: Lang | null;

  detectarIdioma: (text: string) => Promise<DetectIdiomaResult>;

  // booking context
  convoCtx: any;
};

type WeightedLangDecision = {
  lang: Lang | null;
  confidence: number;
  source: "heuristic" | "openai" | "none";
};

function normalizeLang(value: unknown): Lang | null {
  return value === "es" || value === "en" ? value : null;
}

function countAlphaChars(text: string): number {
  const matches = String(text || "").match(/\p{L}/gu);
  return matches ? matches.length : 0;
}

function segmentTextForLanguageVoting(text: string): string[] {
  const raw = String(text || "").trim();
  if (!raw) return [];

  type SegmentLike = {
    segment: string;
    isWordLike?: boolean;
  };

  type SegmenterLike = {
    segment(input: string): Iterable<SegmentLike>;
  };

  const intlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: "sentence" | "word" }
    ) => SegmenterLike;
  };

  const sentenceSeg =
    typeof intlWithSegmenter.Segmenter === "function"
      ? new intlWithSegmenter.Segmenter(undefined, {
          granularity: "sentence",
        })
      : null;

  const wordSeg =
    typeof intlWithSegmenter.Segmenter === "function"
      ? new intlWithSegmenter.Segmenter(undefined, {
          granularity: "word",
        })
      : null;

  const sentenceCandidates = sentenceSeg
    ? Array.from(sentenceSeg.segment(raw))
        .map((item: SegmentLike) => String(item.segment || "").trim())
        .filter((part) => part.length >= 4 && countAlphaChars(part) >= 3)
    : [raw];

  const result: string[] = [];

  for (const sentence of sentenceCandidates) {
    result.push(sentence);

    if (!wordSeg) continue;

    const words = Array.from(wordSeg.segment(sentence))
      .filter((item: SegmentLike) => item.isWordLike === true)
      .map((item: SegmentLike) => String(item.segment || "").trim())
      .filter(Boolean);

    if (words.length < 3) continue;

    const windowSizes = [3, 4, 5, 6];

    for (const size of windowSizes) {
      if (words.length < size) continue;

      for (let i = 0; i <= words.length - size; i++) {
        const chunk = words.slice(i, i + size).join(" ").trim();
        if (chunk.length >= 6 && countAlphaChars(chunk) >= 4) {
          result.push(chunk);
        }
      }
    }
  }

  return Array.from(new Set(result));
}

function splitIntoSemanticChunks(text: string): string[] {
  return segmentTextForLanguageVoting(text);
}

async function detectDominantLanguageFromChunks(args: {
  text: string;
  detectarIdioma: (text: string) => Promise<DetectIdiomaResult>;
}): Promise<WeightedLangDecision> {
  const chunks = splitIntoSemanticChunks(args.text);

  if (!chunks.length) {
    return {
      lang: null,
      confidence: 0,
      source: "none",
    };
  }

  let esScore = 0;
  let enScore = 0;
  let bestSource: "heuristic" | "openai" | "none" = "none";

  for (const chunk of chunks) {
    try {
      const detected = await args.detectarIdioma(chunk);
      const lang = normalizeLang(detected?.lang);
      const confidence = Number(detected?.confidence ?? 0);

      if (!lang || confidence <= 0) {
        continue;
      }

      const weight = Math.max(countAlphaChars(chunk), 1) * confidence;

      if (lang === "es") esScore += weight;
      if (lang === "en") enScore += weight;

      if (detected?.source === "openai") {
        bestSource = "openai";
      } else if (bestSource === "none" && detected?.source === "heuristic") {
        bestSource = "heuristic";
      }
    } catch {
      // no romper el turno
    }
  }

  const total = esScore + enScore;
    if (total <= 0) {
      return {
        lang: null,
        confidence: 0,
        source: "none",
      };
    }

    const winner: Lang = esScore >= enScore ? "es" : "en";
    const winnerScore = Math.max(esScore, enScore);
    const loserScore = Math.min(esScore, enScore);

    const confidence = winnerScore / total;
    const margin = winnerScore - loserScore;

    const minEvidence = 8;

    // exigimos evidencia agregada real, no una coincidencia aislada
    if (winnerScore < minEvidence || confidence < 0.6 || margin < 2) {
      return {
        lang: null,
        confidence: 0,
        source: bestSource,
      };
    }

    return {
      lang: winner,
      confidence,
      source: bestSource,
    };
}

export async function resolveTurnLangClientFirst(
  args: ResolveArgs
): Promise<{
  finalLang: Lang;
  detectedLang: Lang | null;
  detectedConfidence: number;
  detectedSource: "heuristic" | "openai" | "none";
  lockedLang: Lang | null;
  inBookingLang: boolean;
  shouldPersist: boolean;
}> {
  const {
    userInput,
    tenantBase,
    storedLang,
    detectarIdioma,
    convoCtx,
  } = args;

  let detectedLang: Lang | null = null;
  let detectedConfidence = 0;
  let detectedSource: "heuristic" | "openai" | "none" = "none";

  try {
    const detected = await detectarIdioma(userInput);

    detectedLang = normalizeLang(detected?.lang);
    detectedConfidence = Number(detected?.confidence ?? 0);
    detectedSource = detected?.source ?? "none";
  } catch (err) {
    console.error("[resolveTurnLangClientFirst] detectarIdioma error", err);
  }

  // segunda pasada para mensajes mixtos o mal detectados
  if (!detectedLang || detectedConfidence < 0.8) {
    const chunkDecision = await detectDominantLanguageFromChunks({
      text: userInput,
      detectarIdioma,
    });

    if (
      chunkDecision.lang &&
      chunkDecision.confidence > detectedConfidence
    ) {
      detectedLang = chunkDecision.lang;
      detectedConfidence = chunkDecision.confidence;
      detectedSource = chunkDecision.source;
    }
  }

  // lock SOLO durante booking
  const bookingStepLang = (convoCtx as any)?.booking?.step;
  const inBookingLang = !!(bookingStepLang && bookingStepLang !== "idle");

  const rawLockedLang = inBookingLang
    ? ((convoCtx as any)?.booking?.lang ||
        (convoCtx as any)?.thread_lang ||
        null)
    : null;

  const lockedLang: Lang | null = normalizeLang(rawLockedLang);

  let finalLang: Lang = tenantBase;
  let shouldPersist = false;

  if (lockedLang) {
    finalLang = lockedLang;
  } else if (detectedLang) {
    finalLang = detectedLang;
    shouldPersist = detectedConfidence >= 0.8;
  } else if (storedLang === "en" || storedLang === "es") {
    finalLang = storedLang;
  } else {
    finalLang = tenantBase;
  }

  return {
    finalLang,
    detectedLang,
    detectedConfidence,
    detectedSource,
    lockedLang,
    inBookingLang,
    shouldPersist,
  };
}