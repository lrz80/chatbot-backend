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

    detectedLang = detected?.lang ?? null;
    detectedConfidence = Number(detected?.confidence ?? 0);
    detectedSource = detected?.source ?? "none";
  } catch (err) {
    console.error("[resolveTurnLangClientFirst] detectarIdioma error", err);
  }

  // lock SOLO durante booking
  const bookingStepLang = (convoCtx as any)?.booking?.step;
  const inBookingLang = !!(bookingStepLang && bookingStepLang !== "idle");

  const rawLockedLang = inBookingLang
    ? ((convoCtx as any)?.booking?.lang ||
        (convoCtx as any)?.thread_lang ||
        null)
    : null;

  const lockedLang: Lang | null =
    rawLockedLang === "es" || rawLockedLang === "en"
      ? rawLockedLang
      : null;

  let finalLang: Lang = tenantBase;
  let shouldPersist = false;

  if (lockedLang === "en" || lockedLang === "es") {
    finalLang = lockedLang;
  } else if (detectedLang === "en" || detectedLang === "es") {
    finalLang = detectedLang;
    // OJO: aquí solo proponemos. La persistencia real se decide en resolveLangForTurn.ts
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