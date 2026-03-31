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
    detectedConfidence?: number;
    detectedSource?: "heuristic" | "openai" | "none";
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

  if (
    t.includes("english please") ||
    t.includes("in english") ||
    t.includes("speak english") ||
    t.includes("answer in english")
  ) {
    return "en";
  }

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

function hasClearNaturalLanguageSignal(text: string): boolean {
  const t = normalizeChoice(text);
  if (!t) return false;

  const tokens = t.split(" ").filter(Boolean);
  const meaningfulTokens = tokens.filter((token) => token.length >= 4);

  // Frases naturales de 2+ palabras con contenido suficiente
  // no deben tratarse como "short label" o turno ambiguo.
  return tokens.length >= 2 && meaningfulTokens.length >= 1 && t.length >= 8;
}

function isAmbiguousTurn(text: string, ctx: any): boolean {
  const raw = String(text || "").trim();
  const t = normalizeChoice(raw);

  if (!t) return true;

  // Selecciones numéricas siguen siendo ambiguas
  if (/^[0-9]+$/.test(t)) return true;

  // Si está escogiendo de una lista reciente, conserva idioma previo
  if (hasRecentListAndMatch(ctx, raw)) return true;

  // Una frase natural clara no debe tratarse como short label ambiguo
  // Ej: "horarios y precios", "where are you located", "quiero más información"
  if (hasClearNaturalLanguageSignal(raw)) return false;

  if (looksLikeShortLabel(raw)) return true;

  // tokens muy cortos / ambiguos
  if (t.length <= 3) return true;

  return false;
}

function isStrongDetectedTurn(args: {
  text: string;
  detectedLang: Lang | null;
  detectedConfidence?: number;
  ctx: any;
  inBookingLang: boolean;
}): boolean {
  const { text, detectedLang, detectedConfidence = 0, ctx, inBookingLang } = args;

  if (inBookingLang) return false;
  if (detectedLang !== "es" && detectedLang !== "en") return false;
  if (isAmbiguousTurn(text, ctx)) return false;

  return detectedConfidence >= 0.8;
}

export async function resolveLangForTurn(
  args: ResolveLangArgs
): Promise<LangResolutionResult> {
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

  const storedLang = await getIdiomaClienteDB(
    pool,
    tenant.id,
    canal,
    contactoNorm,
    tenantBase
  );

  let idiomaDestino: Lang = tenantBase;

  const isChoosing =
    storedLang === "es" || storedLang === "en"
      ? isChoosingFromCtxListsEarly(convoCtx, text)
      : false;

  if (isChoosing) {
    idiomaDestino = storedLang as Lang;
    forcedLangThisTurn = idiomaDestino;

    console.log("🌍 LANG EARLY-LOCK (ctx list pick) =>", {
      userInput,
      storedLang,
    });
  }

  const langRes = forcedLangThisTurn
    ? {
        finalLang: forcedLangThisTurn,
        detectedLang: null,
        detectedConfidence: 0,
        detectedSource: "none" as const,
        lockedLang: forcedLangThisTurn,
        inBookingLang: false,
        shouldPersist: false,
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

  idiomaDestino = forcedLangThisTurn ? forcedLangThisTurn : langRes.finalLang;

  const explicitLang = detectExplicitLanguageSwitch(text);

  const threadLang = String((convoCtx as any)?.thread_lang || "").toLowerCase();

  const estimateFlow = (convoCtx as any)?.estimateFlow;
  const estimateFlowActive =
    estimateFlow &&
    typeof estimateFlow === "object" &&
    estimateFlow.active === true;

  const estimateFlowStep = String(estimateFlow?.step || "").trim();

  const ESTIMATE_FLOW_LOCKED_STEPS = new Set([
    "awaiting_name",
    "awaiting_phone",
    "awaiting_address",
    "awaiting_job_type",
    "awaiting_date",
    "awaiting_slot_choice",
    "offering_slots",
    "ready_to_schedule",
    "ready_to_cancel",
    "manage_existing",
  ]);

  const estimateFlowLang =
    estimateFlow?.lang === "es" || estimateFlow?.lang === "en"
      ? estimateFlow.lang
      : null;

  const shouldLockLanguageToEstimateFlow =
    estimateFlowActive &&
    ESTIMATE_FLOW_LOCKED_STEPS.has(estimateFlowStep) &&
    (estimateFlowLang === "es" || estimateFlowLang === "en");

  const ambiguousTurn = isAmbiguousTurn(text, convoCtx);

  const strongDetectedTurn = isStrongDetectedTurn({
    text,
    detectedLang: langRes.detectedLang,
    detectedConfidence: langRes.detectedConfidence,
    ctx: convoCtx,
    inBookingLang: langRes.inBookingLang,
  });

  // 0) Forced lang manda
  if (forcedLangThisTurn) {
    idiomaDestino = forcedLangThisTurn;
  }
  // 1) Switch explícito del usuario
  else if (explicitLang) {
    idiomaDestino = explicitLang;
    convoCtx = {
      ...(convoCtx || {}),
      thread_lang: explicitLang,
    };

    if (estimateFlowActive) {
      convoCtx = {
        ...(convoCtx || {}),
        estimateFlow: {
          ...(estimateFlow || {}),
          lang: explicitLang,
        },
      };
    }

    console.log("🌍 LANG EXPLICIT SWITCH", {
      userInput: text,
      to: explicitLang,
    });
  }
  // 2) Si estimate flow está activo en step estructurado, bloquear idioma al del flow
  else if (shouldLockLanguageToEstimateFlow && estimateFlowLang) {
    idiomaDestino = estimateFlowLang;

    console.log("🌍 LANG LOCKED TO ESTIMATE FLOW", {
      userInput: text,
      estimateFlowStep,
      estimateFlowLang,
      detectedLang: langRes.detectedLang,
      detectedConfidence: langRes.detectedConfidence,
      detectedSource: langRes.detectedSource,
      prev: storedLang,
    });
  }
  // 3) Turno fuerte detectado
  else if (strongDetectedTurn && langRes.detectedLang) {
    idiomaDestino = langRes.detectedLang;

    console.log("🌍 LANG STRONG DETECTED TURN", {
      userInput: text,
      detectedLang: langRes.detectedLang,
      detectedConfidence: langRes.detectedConfidence,
      detectedSource: langRes.detectedSource,
      prev: storedLang,
    });
  }

  // 4) Si el turno es ambiguo, conserva thread_lang si existe
  else if ((threadLang === "es" || threadLang === "en") && ambiguousTurn) {
    idiomaDestino = threadLang as Lang;
  }
  // 5) Si hay thread_lang previo, úsalo como fallback principal
  else if (threadLang === "es" || threadLang === "en") {
    idiomaDestino = threadLang as Lang;
  }
  // 6) Luego storedLang
  else if (storedLang === "es" || storedLang === "en") {
    idiomaDestino = storedLang as Lang;
  }
  // 7) Luego tenantBase
  else {
    idiomaDestino = tenantBase;
  }

  // Size tokens: mantener idioma previo
  const tLower = text.trim().toLowerCase();
  const isSizeToken =
    /^(small|medium|large|x-large|xl|xs|peque(n|ñ)o|mediano|grande)$/i.test(
      tLower
    );

  if (isSizeToken && (storedLang === "es" || storedLang === "en")) {
    idiomaDestino = storedLang as Lang;
  }

  // Si es short label y detector quiso flippear, no cambies,
  // PERO solo cuando NO hubo una detección fuerte del turno actual.
  if (
    !strongDetectedTurn &&
    !langRes.inBookingLang &&
    (storedLang === "es" || storedLang === "en") &&
    (langRes.detectedLang === "es" || langRes.detectedLang === "en") &&
    langRes.detectedLang !== storedLang &&
    looksLikeShortLabel(text)
  ) {
    idiomaDestino = storedLang as Lang;
  }

  // Si está escogiendo desde lista reciente, no flippear
  if (hasRecentListAndMatch(convoCtx, text)) {
    const locked =
      storedLang === "es" || storedLang === "en"
        ? storedLang
        : idiomaDestino || tenantBase;

    idiomaDestino = locked as Lang;

    console.log("🌍 LANG LOCK (choice token, no flip) =>", {
      userInput,
      storedLang,
      locked,
      tenantBase,
    });
  }

  // Guardar thread_lang con el idioma final del turno
  if (idiomaDestino === "es" || idiomaDestino === "en") {
    convoCtx = {
      ...(convoCtx || {}),
      thread_lang: idiomaDestino,
    };
  }

  // Persistir solo si hubo señal fuerte o switch explícito
  const shouldPersistDetectedTurn =
    !langRes.inBookingLang &&
    !shouldLockLanguageToEstimateFlow &&
    (idiomaDestino === "es" || idiomaDestino === "en") &&
    !ambiguousTurn &&
    (
      explicitLang !== null ||
      (
        (langRes.detectedLang === "es" || langRes.detectedLang === "en") &&
        (langRes.detectedConfidence ?? 0) >= 0.8
      )
    );

  if (shouldPersistDetectedTurn && storedLang !== idiomaDestino) {
    await upsertIdiomaClienteDB(
      pool,
      tenant.id,
      canal,
      contactoNorm,
      idiomaDestino
    );
  }

  const promptBase = getPromptPorCanal(canal, tenant, idiomaDestino);
  const promptBaseMem = promptBase;

  console.log("🌍 [resolveLangForTurn] RESULT =", {
    canal,
    contactoNorm,
    idiomaDestino,
    storedLang,
    detectedLang: langRes.detectedLang,
    detectedConfidence: langRes.detectedConfidence,
    detectedSource: langRes.detectedSource,
    ambiguousTurn,
    strongDetectedTurn,
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