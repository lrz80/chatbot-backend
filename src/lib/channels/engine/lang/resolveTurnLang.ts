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

function splitIntoSemanticChunks(text: string): string[] {
  return String(text || "")
    .split(/[\n\r.!?;:]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 6 && countAlphaChars(part) >= 4);
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

  // exigimos dominancia real para no voltear idioma por ruido
  if (confidence < 0.6 || margin < 2) {
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