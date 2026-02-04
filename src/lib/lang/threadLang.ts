// src/lib/lang/threadLang.ts
import type { Canal } from "../detectarIntencion";
import { detectarIdioma } from "../detectarIdioma";

export type Lang = "es" | "en";

export type LangResolveDeps = {
  tenantId: string;
  canal: Canal;                  // "whatsapp" | "facebook" | "instagram" | ...
  contacto: string;              // WA phone, FB/IG senderId
  tenantDefaultLang: Lang;       // lang base del tenant
  userText: string;

  // state actual del hilo
  convo: {
    activeFlow?: any;
    activeStep?: any;
    context?: any;               // aquí vive thread_lang + booking
  };

  // persistence hooks (para que sea reusable)
  getCustomerLang: (args: { tenantId: string; canal: string; contacto: string }) => Promise<Lang | null>;
  upsertCustomerLang: (args: { tenantId: string; canal: string; contacto: string; lang: Lang }) => Promise<void>;

  // opcional: si quieres permitir /english /espanol
  allowExplicitSwitch?: boolean;
};

function normalizeLang(x: any): Lang {
  return String(x || "").toLowerCase() === "en" ? "en" : "es";
}

function isBookingActive(ctx: any) {
  const step = ctx?.booking?.step;
  return !!step && step !== "idle";
}

function isAnyLoopActive(convo: any) {
  if (isBookingActive(convo?.context)) return true;
  if (convo?.activeFlow) return true;
  if (convo?.activeStep) return true;
  return false;
}

function shouldDetectNow(userText: string) {
  const t = String(userText || "").trim();
  if (!t) return false;
  if (t.length < 10) return false;
  if (/^\d+$/.test(t)) return false;
  return true;
}

function userRequestsLangSwitch(text: string) {
  const t = String(text || "").toLowerCase();
  return /\b(english|ingl[eé]s|en)\b/.test(t) || /\b(español|espanol|spanish|es)\b/.test(t);
}

export async function resolveThreadLang(deps: LangResolveDeps): Promise<{
  lang: Lang;
  ctxPatch: any;     // patch para persistir en conversation_state.context
  didPersistCustomerLang: boolean;
}> {
  const ctx = deps.convo?.context || {};
  const bookingLang = ctx?.booking?.lang ? normalizeLang(ctx.booking.lang) : null;
  const threadLang = ctx?.thread_lang ? normalizeLang(ctx.thread_lang) : null;

  const loopActive = isAnyLoopActive(deps.convo);

  // 1) Booking activo -> manda booking.lang (sticky)
  if (isBookingActive(ctx) && bookingLang) {
    return {
      lang: bookingLang,
      ctxPatch: { ...ctx, thread_lang: threadLang || bookingLang, booking: { ...(ctx.booking || {}), lang: bookingLang } },
      didPersistCustomerLang: false,
    };
  }

  // 2) Cualquier loop activo -> manda thread_lang si existe (sticky)
  if (loopActive && threadLang) {
    return { lang: threadLang, ctxPatch: ctx, didPersistCustomerLang: false };
  }

  // 3) Fuera de loop: usa DB si existe, si no tenant default
  const dbLang = await deps.getCustomerLang({ tenantId: deps.tenantId, canal: deps.canal, contacto: deps.contacto }).catch(() => null);
  let effective: Lang = normalizeLang(dbLang || deps.tenantDefaultLang);

  let didPersist = false;

  // 4) Permitir switch explícito (opcional)
  if (deps.allowExplicitSwitch && userRequestsLangSwitch(deps.userText)) {
    const det = await detectarIdioma(deps.userText).catch(() => null);
    effective = normalizeLang(det || effective);
    await deps.upsertCustomerLang({ tenantId: deps.tenantId, canal: deps.canal, contacto: deps.contacto, lang: effective });
    didPersist = true;

    return {
      lang: effective,
      ctxPatch: { ...ctx, thread_lang: effective },
      didPersistCustomerLang: didPersist,
    };
  }

  // 5) Si no había thread_lang, y el texto amerita detectar -> detecta UNA vez y lock
  if (!threadLang && shouldDetectNow(deps.userText)) {
    const det = await detectarIdioma(deps.userText).catch(() => null);
    effective = normalizeLang(det || effective);

    await deps.upsertCustomerLang({ tenantId: deps.tenantId, canal: deps.canal, contacto: deps.contacto, lang: effective });
    didPersist = true;

    return {
      lang: effective,
      ctxPatch: { ...ctx, thread_lang: effective },
      didPersistCustomerLang: didPersist,
    };
  }

  // 6) Si ya había thread_lang, úsalo aunque no haya loop (estabilidad)
  if (threadLang) effective = threadLang;

  return { lang: effective, ctxPatch: { ...ctx, thread_lang: threadLang || effective }, didPersistCustomerLang: didPersist };
}
