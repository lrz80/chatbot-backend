// src/lib/channels/engine/lang/resolveLangForTurn.ts

import { Pool } from "pg";
import { detectarIdioma } from "../../../detectarIdioma";
import type { Canal } from "../../../detectarIntencion";
import { getPromptPorCanal } from "../../../getPromptPorCanal";
import {
  getIdiomaClienteDB,
  upsertIdiomaClienteDB,
} from "../clients/clientDb";
import { resolveTurnLangClientFirst } from "./resolveTurnLang";
import { looksLikeShortLabel } from "./looksLikeShortLabel";
import {
  normalizeLangCode,
  type LangCode,
} from "../../../i18n/lang";
import {
  defaultLanguagePolicy,
  type LanguagePolicy,
} from "../../../i18n/languagePolicy";
import { resolveTurnLanguage } from "../../../i18n/resolveTurnLanguage";
import { detectExplicitLanguageSwitch } from "../../../i18n/detectExplicitLanguageSwitch";

type ResolveLangArgs = {
  pool: Pool;
  tenant: any;
  canal: Canal;
  contactoNorm: string;
  userInput: string;
  convoCtx: any;
  tenantBase: LangCode;
  forcedLangThisTurn?: LangCode | null;
  languagePolicy?: LanguagePolicy;
};

export type LangResolutionResult = {
  idiomaDestino: LangCode;
  promptBase: string;
  promptBaseMem: string;
  langRes: {
    finalLang: LangCode;
    detectedLang: LangCode | null;
    detectedConfidence?: number;
    detectedSource?: "heuristic" | "openai" | "none";
    lockedLang: LangCode | null;
    inBookingLang: boolean;
    shouldPersist?: boolean;
  };
  storedLang: LangCode | null;
  convoCtx: any;
  turnLanguage: ReturnType<typeof resolveTurnLanguage>;
};

function normalizeChoice(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  return tokens.length >= 2 && meaningfulTokens.length >= 1 && t.length >= 8;
}

function isAmbiguousTurn(text: string, ctx: any): boolean {
  const raw = String(text || "").trim();
  const t = normalizeChoice(raw);

  if (!t) return true;
  if (/^[0-9]+$/.test(t)) return true;
  if (hasRecentListAndMatch(ctx, raw)) return true;
  if (hasClearNaturalLanguageSignal(raw)) return false;
  if (looksLikeShortLabel(raw)) return true;
  if (t.length <= 3) return true;

  return false;
}

function isStrongDetectedTurn(args: {
  text: string;
  detectedLang: LangCode | null;
  detectedConfidence?: number;
  ctx: any;
  inBookingLang: boolean;
}): boolean {
  const { text, detectedLang, detectedConfidence = 0, ctx, inBookingLang } = args;

  if (inBookingLang) return false;
  if (!normalizeLangCode(detectedLang)) return false;
  if (isAmbiguousTurn(text, ctx)) return false;

  return detectedConfidence >= 0.8;
}

function getEstimateFlowLockedSteps(): Set<string> {
  return new Set([
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
    languagePolicy = defaultLanguagePolicy,
  } = args;

  let { convoCtx, forcedLangThisTurn } = args;

  const text = String(userInput || "");
  const normalizedTenantBase =
    normalizeLangCode(tenantBase) ?? languagePolicy.fallbackOutputLanguage;

  const storedLang = normalizeLangCode(
    await getIdiomaClienteDB(pool, tenant.id, canal, contactoNorm, normalizedTenantBase)
  );

  let idiomaDestino: LangCode = normalizedTenantBase;

  const isChoosing =
    Boolean(storedLang) && isChoosingFromCtxListsEarly(convoCtx, text);

  if (isChoosing && storedLang) {
    idiomaDestino = storedLang;
    forcedLangThisTurn = idiomaDestino;

    console.log("🌍 LANG EARLY-LOCK (ctx list pick) =>", {
      userInput,
      storedLang,
    });
  }

  const rawLangRes = forcedLangThisTurn
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
        tenantBase: normalizedTenantBase,
        storedLang,
        detectarIdioma,
        convoCtx,
      });

  const langRes = {
    finalLang:
      normalizeLangCode(rawLangRes.finalLang) ?? normalizedTenantBase,
    detectedLang: normalizeLangCode(rawLangRes.detectedLang),
    detectedConfidence: rawLangRes.detectedConfidence,
    detectedSource: rawLangRes.detectedSource,
    lockedLang: normalizeLangCode(rawLangRes.lockedLang),
    inBookingLang: Boolean(rawLangRes.inBookingLang),
    shouldPersist: rawLangRes.shouldPersist,
  };

  const explicitLang = detectExplicitLanguageSwitch(text);
  const threadLang = normalizeLangCode((convoCtx as any)?.thread_lang);

  const estimateFlow = (convoCtx as any)?.estimateFlow;
  const estimateFlowActive =
    estimateFlow &&
    typeof estimateFlow === "object" &&
    estimateFlow.active === true;

  const estimateFlowStep = String(estimateFlow?.step || "").trim();
  const estimateFlowLang = normalizeLangCode(estimateFlow?.lang);

  const shouldLockLanguageToEstimateFlow =
    estimateFlowActive &&
    getEstimateFlowLockedSteps().has(estimateFlowStep) &&
    Boolean(estimateFlowLang);

  const ambiguousTurn = isAmbiguousTurn(text, convoCtx);

  const strongDetectedTurn = isStrongDetectedTurn({
    text,
    detectedLang: langRes.detectedLang,
    detectedConfidence: langRes.detectedConfidence,
    ctx: convoCtx,
    inBookingLang: langRes.inBookingLang,
  });

  const baseResolution = resolveTurnLanguage({
    forcedLang: forcedLangThisTurn,
    detectedLang: langRes.detectedLang,
    storedLang,
    threadLang,
    tenantBase: normalizedTenantBase,
    policy: languagePolicy,
  });

  idiomaDestino = baseResolution.outputLang;

  if (forcedLangThisTurn) {
    idiomaDestino =
      normalizeLangCode(forcedLangThisTurn) ?? baseResolution.outputLang;
  } else if (explicitLang) {
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
  } else if (shouldLockLanguageToEstimateFlow && estimateFlowLang) {
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
  } else if (strongDetectedTurn && langRes.detectedLang) {
    idiomaDestino = langRes.detectedLang;

    console.log("🌍 LANG STRONG DETECTED TURN", {
      userInput: text,
      detectedLang: langRes.detectedLang,
      detectedConfidence: langRes.detectedConfidence,
      detectedSource: langRes.detectedSource,
      prev: storedLang,
    });
  } else if (threadLang && ambiguousTurn) {
    idiomaDestino = threadLang;
  } else if (threadLang) {
    idiomaDestino = threadLang;
  } else if (storedLang) {
    idiomaDestino = storedLang;
  } else {
    idiomaDestino = normalizedTenantBase;
  }

  const normalizedToken = normalizeChoice(text);
  const sizeTokens = new Set([
    "small",
    "medium",
    "large",
    "x large",
    "xl",
    "xs",
    "pequeno",
    "pequeño",
    "mediano",
    "grande",
  ]);

  if (sizeTokens.has(normalizedToken) && storedLang) {
    idiomaDestino = storedLang;
  }

  if (
    !strongDetectedTurn &&
    !langRes.inBookingLang &&
    storedLang &&
    langRes.detectedLang &&
    langRes.detectedLang !== storedLang &&
    looksLikeShortLabel(text)
  ) {
    idiomaDestino = storedLang;
  }

  if (hasRecentListAndMatch(convoCtx, text)) {
    const locked = storedLang || idiomaDestino || normalizedTenantBase;
    idiomaDestino = locked;

    console.log("🌍 LANG LOCK (choice token, no flip) =>", {
      userInput,
      storedLang,
      locked,
      tenantBase: normalizedTenantBase,
    });
  }

  if (normalizeLangCode(idiomaDestino)) {
    convoCtx = {
      ...(convoCtx || {}),
      thread_lang: idiomaDestino,
    };
  }

  const shouldPersistDetectedTurn =
    !langRes.inBookingLang &&
    !shouldLockLanguageToEstimateFlow &&
    Boolean(normalizeLangCode(idiomaDestino)) &&
    !ambiguousTurn &&
    (
      explicitLang !== null ||
      (Boolean(langRes.detectedLang) && (langRes.detectedConfidence ?? 0) >= 0.8)
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
    langRes: {
      ...langRes,
      finalLang: idiomaDestino,
      lockedLang: normalizeLangCode(forcedLangThisTurn) ?? langRes.lockedLang,
    },
    storedLang,
    convoCtx,
    turnLanguage: resolveTurnLanguage({
      forcedLang: forcedLangThisTurn,
      detectedLang: langRes.detectedLang,
      storedLang,
      threadLang: normalizeLangCode((convoCtx as any)?.thread_lang),
      tenantBase: normalizedTenantBase,
      policy: languagePolicy,
    }),
  };
}