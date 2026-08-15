// src/lib/channels/engine/lang/resolveTurnLang.ts

import type { Pool } from "pg";

import {
  normalizeLangCode,
  type LangCode,
} from "../../../i18n/lang";

type DetectIdiomaResult = {
  lang: unknown;
  confidence: number;
  source: "heuristic" | "openai" | "none";
};

type ResolveArgs = {
  pool: Pool;

  tenantId: string;
  canal: string;
  contacto: string;

  userInput: string;

  tenantBase: LangCode;
  storedLang: LangCode | null;

  detectarIdioma: (
    text: string
  ) => Promise<DetectIdiomaResult>;

  // booking context
  convoCtx: any;
};

type WeightedLangDecision = {
  lang: LangCode | null;
  confidence: number;
  source: "heuristic" | "openai" | "none";
};

function normalizeLang(
  value: unknown
): LangCode | null {
  return normalizeLangCode(
    value == null ? null : String(value)
  );
}

function countAlphaChars(text: string): number {
  const matches =
    String(text || "").match(/\p{L}/gu);

  return matches ? matches.length : 0;
}

function segmentTextForLanguageVoting(
  text: string
): string[] {
  const raw = String(text || "").trim();

  if (!raw) {
    return [];
  }

  type SegmentLike = {
    segment: string;
    isWordLike?: boolean;
  };

  type SegmenterLike = {
    segment(
      input: string
    ): Iterable<SegmentLike>;
  };

  const intlWithSegmenter =
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: {
          granularity:
            | "sentence"
            | "word";
        }
      ) => SegmenterLike;
    };

  const sentenceSeg =
    typeof intlWithSegmenter.Segmenter ===
    "function"
      ? new intlWithSegmenter.Segmenter(
          undefined,
          {
            granularity: "sentence",
          }
        )
      : null;

  const wordSeg =
    typeof intlWithSegmenter.Segmenter ===
    "function"
      ? new intlWithSegmenter.Segmenter(
          undefined,
          {
            granularity: "word",
          }
        )
      : null;

  const sentenceCandidates =
    sentenceSeg
      ? Array.from(
          sentenceSeg.segment(raw)
        )
          .map((item: SegmentLike) =>
            String(
              item.segment || ""
            ).trim()
          )
          .filter(
            (part) =>
              part.length >= 4 &&
              countAlphaChars(part) >= 3
          )
      : [raw];

  const result: string[] = [];

  for (const sentence of sentenceCandidates) {
    result.push(sentence);

    if (!wordSeg) {
      continue;
    }

    const words = Array.from(
      wordSeg.segment(sentence)
    )
      .filter(
        (item: SegmentLike) =>
          item.isWordLike === true
      )
      .map((item: SegmentLike) =>
        String(
          item.segment || ""
        ).trim()
      )
      .filter(Boolean);

    if (words.length < 3) {
      continue;
    }

    const windowSizes = [3, 4, 5, 6];

    for (const size of windowSizes) {
      if (words.length < size) {
        continue;
      }

      for (
        let i = 0;
        i <= words.length - size;
        i++
      ) {
        const chunk = words
          .slice(i, i + size)
          .join(" ")
          .trim();

        if (
          chunk.length >= 6 &&
          countAlphaChars(chunk) >= 4
        ) {
          result.push(chunk);
        }
      }
    }
  }

  return Array.from(
    new Set(result)
  );
}

function splitIntoSemanticChunks(
  text: string
): string[] {
  return segmentTextForLanguageVoting(
    text
  );
}

async function detectDominantLanguageFromChunks(
  args: {
    text: string;
    detectarIdioma: (
      text: string
    ) => Promise<DetectIdiomaResult>;
  }
): Promise<WeightedLangDecision> {
  const chunks =
    splitIntoSemanticChunks(args.text);

  if (!chunks.length) {
    return {
      lang: null,
      confidence: 0,
      source: "none",
    };
  }

  /*
   * Universal language voting.
   *
   * No hay idiomas hardcodeados.
   *
   * Ejemplos posibles:
   * es -> score
   * en -> score
   * pt -> score
   * fr -> score
   * de -> score
   * ja -> score
   * etc.
   */
  const scores =
    new Map<LangCode, number>();

  let bestSource:
    | "heuristic"
    | "openai"
    | "none" = "none";

  for (const chunk of chunks) {
    try {
      const detected =
        await args.detectarIdioma(chunk);

      const lang =
        normalizeLang(
          detected?.lang
        );

      const confidence =
        Number(
          detected?.confidence ?? 0
        );

      if (
        !lang ||
        !Number.isFinite(confidence) ||
        confidence <= 0
      ) {
        continue;
      }

      const weight =
        Math.max(
          countAlphaChars(chunk),
          1
        ) * confidence;

      scores.set(
        lang,
        (scores.get(lang) || 0) +
          weight
      );

      if (
        detected?.source === "openai"
      ) {
        bestSource = "openai";
      } else if (
        bestSource === "none" &&
        detected?.source === "heuristic"
      ) {
        bestSource = "heuristic";
      }
    } catch {
      // Nunca romper el turno
      // por una detección secundaria.
    }
  }

  const ranked =
    Array.from(scores.entries())
      .sort(
        (a, b) =>
          b[1] - a[1]
      );

  if (!ranked.length) {
    return {
      lang: null,
      confidence: 0,
      source: bestSource,
    };
  }

  const [
    winnerLang,
    winnerScore,
  ] = ranked[0];

  const runnerUpScore =
    ranked[1]?.[1] || 0;

  const total =
    ranked.reduce(
      (sum, [, score]) =>
        sum + score,
      0
    );

  if (total <= 0) {
    return {
      lang: null,
      confidence: 0,
      source: bestSource,
    };
  }

  const confidence =
    winnerScore / total;

  const margin =
    winnerScore -
    runnerUpScore;

  const minEvidence = 8;

  /*
   * Exige evidencia agregada suficiente
   * sin importar cuál sea el idioma.
   */
  if (
    winnerScore < minEvidence ||
    confidence < 0.6 ||
    margin < 2
  ) {
    return {
      lang: null,
      confidence: 0,
      source: bestSource,
    };
  }

  return {
    lang: winnerLang,
    confidence,
    source: bestSource,
  };
}

export async function resolveTurnLangClientFirst(
  args: ResolveArgs
): Promise<{
  finalLang: LangCode;
  detectedLang: LangCode | null;
  detectedConfidence: number;
  detectedSource:
    | "heuristic"
    | "openai"
    | "none";
  lockedLang: LangCode | null;
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

  let detectedLang:
    | LangCode
    | null = null;

  let detectedConfidence = 0;

  let detectedSource:
    | "heuristic"
    | "openai"
    | "none" = "none";

  try {
    const detected =
      await detectarIdioma(userInput);

    detectedLang =
      normalizeLang(
        detected?.lang
      );

    detectedConfidence =
      Number(
        detected?.confidence ?? 0
      );

    detectedSource =
      detected?.source ?? "none";
  } catch (err) {
    console.error(
      "[resolveTurnLangClientFirst] detectarIdioma error",
      err
    );
  }

  /*
   * Segunda pasada para:
   * - idioma inicialmente desconocido
   * - mensajes mixtos
   * - baja confianza
   *
   * También es completamente
   * multiidioma.
   */
  if (
    !detectedLang ||
    detectedConfidence < 0.8
  ) {
    const chunkDecision =
      await detectDominantLanguageFromChunks(
        {
          text: userInput,
          detectarIdioma,
        }
      );

    if (
      chunkDecision.lang &&
      chunkDecision.confidence >
        detectedConfidence
    ) {
      detectedLang =
        chunkDecision.lang;

      detectedConfidence =
        chunkDecision.confidence;

      detectedSource =
        chunkDecision.source;
    }
  }

  /*
   * Lock durante booking.
   *
   * El idioma guardado en el booking
   * tiene prioridad para impedir cambios
   * accidentales por respuestas cortas,
   * nombres, direcciones, teléfonos, etc.
   */
  const bookingStepLang =
    (convoCtx as any)?.booking?.step;

  const inBookingLang =
    Boolean(
      bookingStepLang &&
      bookingStepLang !== "idle"
    );

  const rawLockedLang =
    inBookingLang
      ? (
          (convoCtx as any)
            ?.booking?.lang ||
          (convoCtx as any)
            ?.thread_lang ||
          null
        )
      : null;

  const lockedLang =
    normalizeLang(
      rawLockedLang
    );

  const normalizedTenantBase =
    normalizeLang(tenantBase) ||
    tenantBase;

  const normalizedStoredLang =
    normalizeLang(storedLang);

  let finalLang: LangCode =
    normalizedTenantBase;

  let shouldPersist = false;

  if (lockedLang) {
    finalLang =
      lockedLang;
  } else if (detectedLang) {
    finalLang =
      detectedLang;

    shouldPersist =
      detectedConfidence >= 0.8;
  } else if (normalizedStoredLang) {
    finalLang =
      normalizedStoredLang;
  } else {
    finalLang =
      normalizedTenantBase;
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