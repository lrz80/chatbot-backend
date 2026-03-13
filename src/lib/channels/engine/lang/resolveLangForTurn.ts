// backend/src/lib/channels/engine/lang/resolveLangForTurn.ts

import { Pool } from "pg";
import { detectarIdioma } from "../../../detectarIdioma";
import type { Canal } from "../../../detectarIntencion";
import { getPromptPorCanal } from "../../../getPromptPorCanal";
import {
  getIdiomaClienteDB,
  upsertIdiomaClienteDB,
} from "../clients/clientDb";
import type { Lang } from "../clients/clientDb";
import { resolveTurnLangClientFirst } from "./resolveTurnLang";
import { looksLikeShortLabel } from "./looksLikeShortLabel";

type ResolveLangArgs = {
  pool: Pool;
  tenant: any;
  canal: Canal;
  contactoNorm: string;
  userInput: string;
  convoCtx: any;
  tenantBase: Lang;
  forcedLangThisTurn?: Lang | null;
};

export type LangResolutionResult = {
  idiomaDestino: Lang;
  promptBase: string;
  promptBaseMem: string;
  langRes: {
    finalLang: Lang;
    detectedLang: Lang | null;
    lockedLang: Lang | null;
    inBookingLang: boolean;
    shouldPersist?: boolean;
  };
  storedLang: Lang | null;
  convoCtx: any;
};

function normalizeChoice(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectExplicitLanguageSwitch(text: string): Lang | null {
  const t = normalizeChoice(text);

  // pedir inglés
  if (
    t.includes("english please") ||
    t.includes("in english") ||
    t.includes("speak english") ||
    t.includes("answer in english")
  ) {
    return "en";
  }

  // pedir español
  if (
    t.includes("en espanol") ||
    t.includes("en español") ||
    t.includes("in spanish") ||
    t.includes("speak spanish") ||
    t.includes("answer in spanish")
  ) {
    return "es";
  }

  return null;
}

function isChoosingFromCtxListsEarly(ctx: any, userText: string): boolean {
  const u = normalizeChoice(userText);
  if (!u) return false;

  const candidates: Array<{ name?: string; label?: string; text?: string }> = [
    ...((ctx?.last_plan_list || []) as any[]),
    ...((ctx?.last_package_list || []) as any[]),
    ...((ctx?.last_service_list || []) as any[]),
    ...((ctx?.pending_link_options || []) as any[]),
  ];

  if (!candidates.length) return false;

  // Respuesta tipo "1", "2" para escoger
  if (/^[1-9]$/.test(u)) return true;

  return candidates.some((it) => {
    const n = normalizeChoice(it?.name || it?.label || it?.text || "");
    if (!n) return false;
    return n.includes(u) || u.includes(n);
  });
}

function hasRecentListAndMatch(ctx: any, userText: string): boolean {
  const u = normalizeChoice(userText);
  if (!u) return false;

  const ttlMs = 10 * 60 * 1000;

  const at1 = Number((ctx as any)?.last_plan_list_at || 0);
  const at2 = Number((ctx as any)?.last_package_list_at || 0);
  const fresh1 = at1 > 0 && Date.now() - at1 <= ttlMs;
  const fresh2 = at2 > 0 && Date.now() - at2 <= ttlMs;

  const lp = Array.isArray((ctx as any)?.last_plan_list)
    ? (ctx as any).last_plan_list
    : [];
  const pk = Array.isArray((ctx as any)?.last_package_list)
    ? (ctx as any).last_package_list
    : [];
  const hasRecent = (fresh1 && lp.length > 0) || (fresh2 && pk.length > 0);

  if (!hasRecent) return false;

  const candidates: Array<{ name?: string; label?: string; text?: string }> = [
    ...(((ctx as any)?.last_plan_list || []) as any[]),
    ...(((ctx as any)?.last_package_list || []) as any[]),
    ...(((ctx as any)?.last_service_list || []) as any[]),
  ];

  return candidates.some((it) => {
    const n = normalizeChoice(it?.name || it?.label || it?.text || "");
    if (!n) return false;
    return n.includes(u) || u.includes(n);
  });
}

function isStrongLanguageTurn(text: string, detectedLang: Lang | null): boolean {
  const t = String(text || "").trim();
  if (!t) return false;

  const words = t.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (detectedLang !== "es" && detectedLang !== "en") return false;

  // Mensajes muy cortos no deben forzar cambio
  if (wordCount <= 2 && t.length < 12) return false;

  return true;
}

export async function resolveLangForTurn(args: ResolveLangArgs): Promise<LangResolutionResult> {
  const {
    pool,
    tenant,
    canal,
    contactoNorm,
    userInput,
    tenantBase,
  } = args;

  let { convoCtx, forcedLangThisTurn } = args;

  const text = String(userInput || "");

  // ===============================
  // 🌍 LANG RESOLUTION (CLIENT-FIRST)
  // ===============================

  const storedLang = await getIdiomaClienteDB(
    pool,
    tenant.id,
    canal,
    contactoNorm,
    tenantBase
  );

  let idiomaDestino: Lang = tenantBase;

  // ✅ LANG EARLY-LOCK: si está eligiendo de listas del ctx, NO recalcules idioma este turno
  const isChoosing =
    storedLang === "es" || storedLang === "en"
      ? isChoosingFromCtxListsEarly(convoCtx, text)
      : false;

  if (isChoosing) {
    idiomaDestino = storedLang as Lang;
    forcedLangThisTurn = idiomaDestino;
    console.log("🌍 LANG EARLY-LOCK (ctx list pick) =>", { userInput, storedLang });
  }

  const langRes = forcedLangThisTurn
    ? {
        finalLang: forcedLangThisTurn,
        detectedLang: forcedLangThisTurn,
        lockedLang: forcedLangThisTurn,   // 👈 mismo tipo: Lang
        inBookingLang: false,
        shouldPersist: true,
        }
    : await resolveTurnLangClientFirst({
        pool,
        tenantId: tenant.id,
        canal,
        contacto: contactoNorm,
        userInput: text,
        tenantBase,
        storedLang,
        detectarIdioma,
        convoCtx,
      });

    // Idioma base propuesto por el resolver
    if (forcedLangThisTurn) {
      idiomaDestino = forcedLangThisTurn;
    } else {
      idiomaDestino = langRes.finalLang;
    }

    // 🌍 Cambio explícito de idioma solicitado por el usuario
  const explicitLang = detectExplicitLanguageSwitch(text);

  if (explicitLang && explicitLang !== idiomaDestino) {
    console.log("🌍 LANG EXPLICIT SWITCH", {
      userInput: text,
      from: idiomaDestino,
      to: explicitLang,
    });

    idiomaDestino = explicitLang;

    convoCtx = {
      ...(convoCtx || {}),
      thread_lang: explicitLang,
    };
  }

  // ✅ REGLA EXTRA: saludo bilingüe "Hi hola / hi buenas..."
  const bilingualGreeting = /^\s*(hi|hello)\s+(hola|buenas|buenos)\b/i.test(text);

  if (
    !langRes.inBookingLang &&
    bilingualGreeting &&
    (storedLang === "es" || tenantBase === "es")
  ) {
    console.log("🌍 LANG OVERRIDE (bilingual greeting → es)", {
      userInput,
      storedLang,
      tenantBase,
      prevLang: idiomaDestino,
    });
    idiomaDestino = "es";
  }

  // ✅ Override por caracteres claramente españoles
  const hasStrongEsChars = /[áéíóúñ¿¡]/i.test(text);

  if (
    !langRes.inBookingLang &&
    hasStrongEsChars &&
    idiomaDestino === "en" &&
    (tenantBase === "es" || storedLang === "es")
  ) {
    console.log("🌍 LANG OVERRIDE (accent chars → es)", {
      userInput,
      storedLang,
      tenantBase,
      prevLang: idiomaDestino,
    });
    idiomaDestino = "es";
  }

  // ✅ LANG LOCK: si ya hay idioma del hilo, respétalo
  const threadLang = String((convoCtx as any)?.thread_lang || "").toLowerCase();

  if (threadLang === "es" || threadLang === "en") {
    idiomaDestino = threadLang as Lang;
  }

  // Tokens de talla (S/M/L) → mantén storedLang
  const tLower = text.trim().toLowerCase();
  const isSizeToken = /^(small|medium|large|x-large|xl|xs|peque(n|ñ)o|mediano|grande)$/i.test(
    tLower
  );

  if (isSizeToken && (storedLang === "es" || storedLang === "en")) {
    idiomaDestino = storedLang as Lang;
  }

  // ✅ NO CAMBIAR IDIOMA por short label (elegir de listas)
  if (
    !langRes.inBookingLang &&
    (storedLang === "es" || storedLang === "en") &&
    (langRes.detectedLang === "es" || langRes.detectedLang === "en") &&
    langRes.detectedLang !== storedLang &&
    looksLikeShortLabel(text)
  ) {
    idiomaDestino = storedLang as Lang;
  }

  // ✅ NO CAMBIAR IDIOMA cuando el usuario está seleccionando una opción con lista reciente
  if (hasRecentListAndMatch(convoCtx, text)) {
    const locked =
      storedLang === "es" || storedLang === "en"
        ? storedLang
        : (idiomaDestino || tenantBase);

    idiomaDestino = locked as Lang;
    console.log("🌍 LANG LOCK (choice token, no flip) =>", {
      userInput,
      storedLang,
      locked,
      tenantBase,
    });
  }

  // ✅ thread_lang fijo desde el inicio del hilo
  if (idiomaDestino === "es" || idiomaDestino === "en") {
    convoCtx = { ...(convoCtx || {}), thread_lang: idiomaDestino };
  }

  // ✅ NO CAMBIAR IDIOMA en mensajes muy cortos (gracias/ok/👍/etc)
  const trimmed = text.trim();
  const isVeryShort = trimmed.length <= 8;

  if (
    !langRes.inBookingLang &&
    (storedLang === "es" || storedLang === "en") &&
    isVeryShort
  ) {
    // Si el detector quiere flippear en un mensaje corto, no lo permitas
    idiomaDestino = storedLang as Lang;
  }

  // 🔒 THREAD LANG FINAL LOCK
  const finalThreadLang = String((convoCtx as any)?.thread_lang || "").toLowerCase();

  const currentTurnShowsStrongLang =
    !langRes.inBookingLang &&
    isStrongLanguageTurn(text, langRes.detectedLang);

  if (
    (finalThreadLang === "es" || finalThreadLang === "en") &&
    !currentTurnShowsStrongLang
  ) {
    idiomaDestino = finalThreadLang as Lang;
  }

  // ✅ Persistir idioma final del turno (sticky) — AL FINAL
  if (
    !langRes.inBookingLang &&
    (idiomaDestino === "es" || idiomaDestino === "en") &&
    langRes.shouldPersist !== false
  ) {
    if (storedLang !== idiomaDestino) {
      await upsertIdiomaClienteDB(pool, tenant.id, canal, contactoNorm, idiomaDestino);
    }
  }

  const promptBase = getPromptPorCanal(canal, tenant, idiomaDestino);
  const promptBaseMem = promptBase;

  console.log("🌍 [resolveLangForTurn] RESULT =", {
    canal,
    contactoNorm,
    idiomaDestino,
    storedLang,
    detectedLang: langRes.detectedLang,
    inBookingLang: langRes.inBookingLang,
  });

  return {
    idiomaDestino,
    promptBase,
    promptBaseMem,
    langRes,
    storedLang: storedLang ?? null,
    convoCtx,
  };
}