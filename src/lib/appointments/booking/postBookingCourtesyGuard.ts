// src/lib/appoinments/booking/postBookingCourtesyGuard.ts

import type { LangCode } from "../../i18n/lang";
import { normalizeLangCode } from "../../i18n/lang";

type PostBookingCourtesyGuardArgs = {
  ctx: any;
  userInput: string;
  idioma: LangCode;
};

type PostBookingCourtesyGuardResult =
  | { hit: true; reply: string }
  | { hit: false };

type CourtesyConfig = {
  repliesByLang: Record<string, string>;
  courtesyByLang: Record<string, string[]>;
};

const COURTESY_CONFIG: CourtesyConfig = {
  repliesByLang: {
    es: "A la orden.",
    en: "You’re welcome.",
    pt: "Por nada.",
    fr: "Avec plaisir.",
    it: "Prego.",
    de: "Gern geschehen.",
  },
  courtesyByLang: {
    es: [
      "gracias",
      "muchas gracias",
      "ok",
      "perfecto",
      "listo",
      "vale",
      "dale",
      "bien",
      "genial",
      "super",
    ],
    en: [
      "thank you",
      "thanks",
      "ok",
      "okay",
      "perfect",
      "great",
      "awesome",
      "cool",
    ],
    pt: [
      "obrigado",
      "obrigada",
      "muito obrigado",
      "muito obrigada",
      "ok",
      "perfeito",
      "beleza",
      "valeu",
      "tudo bem",
      "show",
    ],
    fr: [
      "merci",
      "merci beaucoup",
      "ok",
      "parfait",
      "super",
    ],
    it: [
      "grazie",
      "mille grazie",
      "ok",
      "perfetto",
      "bene",
    ],
    de: [
      "danke",
      "vielen dank",
      "ok",
      "perfekt",
      "super",
    ],
  },
};

const COURTESY_INDEX = buildCourtesyIndex(COURTESY_CONFIG.courtesyByLang);

export function postBookingCourtesyGuard(
  args: PostBookingCourtesyGuardArgs
): PostBookingCourtesyGuardResult {
  const { ctx, userInput, idioma } = args;

  const lastDoneAt = ctx?.booking_last_done_at;
  const completedAtISO = ctx?.booking_completed_at;

  const lastMs =
    typeof lastDoneAt === "number"
      ? lastDoneAt
      : typeof completedAtISO === "string"
        ? Date.parse(completedAtISO)
        : null;

  if (!lastMs || !Number.isFinite(lastMs)) {
    return { hit: false };
  }

  const seconds = (Date.now() - lastMs) / 1000;
  if (seconds < 0 || seconds >= 10 * 60) {
    return { hit: false };
  }

  const normalizedInput = normalizeCourtesyInput(userInput);
  if (!normalizedInput) {
    return { hit: false };
  }

  const matchedCourtesyLang = COURTESY_INDEX.get(normalizedInput);
  if (!matchedCourtesyLang) {
    return { hit: false };
  }

  const normalizedReplyLang = normalizeLangCode(idioma) ?? "es";
  const reply =
    COURTESY_CONFIG.repliesByLang[normalizedReplyLang] ??
    COURTESY_CONFIG.repliesByLang[matchedCourtesyLang] ??
    COURTESY_CONFIG.repliesByLang.es;

  return {
    hit: true,
    reply,
  };
}

function buildCourtesyIndex(
  courtesyByLang: Record<string, string[]>
): Map<string, string> {
  const index = new Map<string, string>();

  for (const [lang, phrases] of Object.entries(courtesyByLang)) {
    for (const phrase of phrases) {
      const normalized = normalizeCourtesyInput(phrase);
      if (!normalized) continue;

      if (!index.has(normalized)) {
        index.set(normalized, lang);
      }
    }
  }

  return index;
}

function normalizeCourtesyInput(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}