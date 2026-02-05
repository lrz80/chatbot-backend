// backend/src/lib/channels/engine/lang/resolveTurnLang.ts
import type { Pool } from "pg";
import type { Lang } from "../clients/clientDb";
import { upsertIdiomaClienteDB } from "../clients/clientDb";

type ResolveArgs = {
  pool: Pool;

  tenantId: string;
  canal: string;
  contacto: string;

  userInput: string;

  tenantBase: Lang;
  storedLang: Lang;

  detectarIdioma: (text: string) => Promise<Lang>;

  // booking context
  convoCtx: any;
};

export async function resolveTurnLangClientFirst(args: ResolveArgs): Promise<{
  finalLang: Lang;
  detectedLang: Lang | null;
  lockedLang: Lang | null;
  inBookingLang: boolean;
  shouldPersist: boolean;
}> {
  const {
    pool,
    tenantId,
    canal,
    contacto,
    userInput,
    tenantBase,
    storedLang,
    detectarIdioma,
    convoCtx,
  } = args;

  // detectar idioma del mensaje (solo si NO es corto/ambiguo)
  let detectedLang: Lang | null = null;

  try {
    const t0 = String(userInput || "").trim().toLowerCase();

    const isAmbiguousShort =
      t0.length <= 2 ||
      /^(ok|okay|k|👍|yes|no|si|sí|hola|hello|hi|hey|thanks|thank you)$/i.test(t0);

    if (!isAmbiguousShort) {
      detectedLang = await detectarIdioma(userInput);
    }
  } catch {}

  // lock SOLO durante booking
  const bookingStepLang = (convoCtx as any)?.booking?.step;
  const inBookingLang = bookingStepLang && bookingStepLang !== "idle";

  const lockedLang =
    inBookingLang
      ? ((convoCtx as any)?.booking?.lang || (convoCtx as any)?.thread_lang || null)
      : null;

  let finalLang: Lang = tenantBase;
  let shouldPersist = false;

  if (lockedLang === "en" || lockedLang === "es") {
    finalLang = lockedLang;
  } else if (!detectedLang) {
    finalLang = storedLang || tenantBase;
  } else {
    finalLang = detectedLang;
    shouldPersist = true;
    // persist sticky
    await upsertIdiomaClienteDB(pool, tenantId, canal, contacto, finalLang);
  }

  return { finalLang, detectedLang, lockedLang, inBookingLang: !!inBookingLang, shouldPersist };
}
