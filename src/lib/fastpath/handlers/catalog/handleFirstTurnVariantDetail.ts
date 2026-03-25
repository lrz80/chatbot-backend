import type { Pool } from "pg";
import type { Lang } from "../../../channels/engine/clients/clientDb";
import type { FastpathResult, FastpathCtx } from "../../runFastpath";

type HandleFirstTurnVariantDetailInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: Lang;
  convoCtx: Partial<FastpathCtx> | null | undefined;
  detectedIntent?: string | null;
  intentOut?: string | null;
  isCatalogOverviewTurn: boolean;
  catalogReferenceClassification?: any;
  traducirMensaje: (texto: string, idiomaDestino: string) => Promise<string>;

  getCatalogStructuredSignals: typeof import("./getCatalogStructuredSignals").getCatalogStructuredSignals;
    answerCatalogQuestionLLM: (input: {
    idiomaDestino: "es" | "en";
    canonicalReply: string;
    userInput: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string | null>;

  renderCatalogReplyWithSalesFrame: (args: {
    lang: Lang;
    userInput: string;
    canonicalReply: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    answerCatalogQuestionLLM: (input: {
      idiomaDestino: "es" | "en";
      canonicalReply: string;
      userInput: string;
      mode?: "grounded_frame_only" | "grounded_catalog_sales";
      maxIntroLines?: number;
      maxClosingLines?: number;
    }) => Promise<string | null>;
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string>;

  getCatalogDetailSignals: typeof import("./getCatalogDetailSignals").getCatalogDetailSignals;

  handleLastVariantIncludes: (args: {
    pool: Pool;
    userInput: string;
    idiomaDestino: Lang;
    convoCtx: Partial<FastpathCtx> | null | undefined;
    detectedIntent?: string | null;
    intentOut?: string | null;
    catalogReferenceClassification?: any;
    traducirMensaje: (texto: string, idiomaDestino: string) => Promise<string>;
    answerCatalogQuestionLLM: (input: {
      idiomaDestino: "es" | "en";
      canonicalReply: string;
      userInput: string;
      mode?: "grounded_frame_only" | "grounded_catalog_sales";
      maxIntroLines?: number;
      maxClosingLines?: number;
    }) => Promise<string | null>;
    renderCatalogReplyWithSalesFrame: (args: {
      lang: Lang;
      userInput: string;
      canonicalReply: string;
      mode?: "grounded_frame_only" | "grounded_catalog_sales";
      answerCatalogQuestionLLM: (input: {
        idiomaDestino: "es" | "en";
        canonicalReply: string;
        userInput: string;
        mode?: "grounded_frame_only" | "grounded_catalog_sales";
        maxIntroLines?: number;
        maxClosingLines?: number;
      }) => Promise<string | null>;
      maxIntroLines?: number;
      maxClosingLines?: number;
    }) => Promise<string>;
  }) => Promise<FastpathResult>;

  resolveFirstTurnServiceDetailTarget: (args: {
    pool: Pool;
    tenantId: string;
    userInput: string;
    idiomaDestino: Lang;
    convoCtx: Partial<FastpathCtx> | null | undefined;
    catalogReferenceClassification?: any;
    normalizeText: (input: string) => string;
    resolveServiceIdFromText: (
      pool: Pool,
      tenantId: string,
      text: string,
      opts?: any
    ) => Promise<any>;
  }) => Promise<
    | { handled: false; hit: any | null }
    | {
        handled: true;
        reply: string;
        source: "service_list_db";
        intent: "info_servicio";
        ctxPatch?: Partial<FastpathCtx>;
      }
  >;

  handleResolvedServiceDetail: (args: {
    pool: Pool;
    userInput: string;
    idiomaDestino: Lang;
    intentOut?: string | null;
    hit: any;
    traducirMensaje: (texto: string, idiomaDestino: string) => Promise<string>;
    convoCtx: Partial<FastpathCtx> | null | undefined;
  }) => Promise<FastpathResult>;

  normalizeText: (input: string) => string;
  resolveServiceIdFromText: (
    pool: Pool,
    tenantId: string,
    text: string,
    opts?: any
  ) => Promise<any>;
};

type HandleFirstTurnVariantDetailResult = FastpathResult;

function shouldEnterFirstTurnVariantDetail(args: {
  detectedIntent?: string | null;
  isCatalogOverviewTurn: boolean;
  catalogReferenceClassification?: any;
  convoCtx: Partial<FastpathCtx> | null | undefined;
  getCatalogStructuredSignals: HandleFirstTurnVariantDetailInput["getCatalogStructuredSignals"];
  getCatalogDetailSignals: HandleFirstTurnVariantDetailInput["getCatalogDetailSignals"];
}) {
  const {
    detectedIntent,
    isCatalogOverviewTurn,
    catalogReferenceClassification,
    convoCtx,
    getCatalogStructuredSignals,
    getCatalogDetailSignals,
  } = args;

  const {
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification,
    convoCtx,
  });

  const detailSignals = getCatalogDetailSignals({
    detectedIntent,
    catalogReferenceClassification,
    convoCtx,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
  });

  const shouldHandle =
    !isCatalogOverviewTurn &&
    detailSignals.looksLikeServiceDetail &&
    !detailSignals.looksLikeEllipticPriceFollowup;

  return {
    shouldHandle,
    detailSignals,
    targetServiceId,
    targetVariantId,
    targetFamilyKey,
  };
}

export async function handleFirstTurnVariantDetail(
  input: HandleFirstTurnVariantDetailInput
): Promise<HandleFirstTurnVariantDetailResult> {
  const {
    pool,
    tenantId,
    userInput,
    idiomaDestino,
    convoCtx,
    detectedIntent,
    intentOut,
    isCatalogOverviewTurn,
    catalogReferenceClassification,
    traducirMensaje,
    answerCatalogQuestionLLM,
    renderCatalogReplyWithSalesFrame,
    getCatalogStructuredSignals,
    getCatalogDetailSignals,
    handleLastVariantIncludes,
    resolveFirstTurnServiceDetailTarget,
    handleResolvedServiceDetail,
    normalizeText,
    resolveServiceIdFromText,
  } = input;

  const gate = shouldEnterFirstTurnVariantDetail({
    detectedIntent,
    isCatalogOverviewTurn,
    catalogReferenceClassification,
    convoCtx,
    getCatalogStructuredSignals,
    getCatalogDetailSignals,
  });

  if (!gate.shouldHandle) {
    return { handled: false };
  }

  const lastVariantIncludesResult = await handleLastVariantIncludes({
    pool,
    userInput,
    idiomaDestino,
    convoCtx,
    detectedIntent,
    intentOut,
    catalogReferenceClassification,
    traducirMensaje,
    answerCatalogQuestionLLM,
    renderCatalogReplyWithSalesFrame,
  });

  if (lastVariantIncludesResult.handled) {
    return lastVariantIncludesResult;
  }

  const targetResolution = await resolveFirstTurnServiceDetailTarget({
    pool,
    tenantId,
    userInput,
    idiomaDestino,
    convoCtx,
    catalogReferenceClassification,
    normalizeText,
    resolveServiceIdFromText,
  });

  if (targetResolution.handled) {
    return targetResolution;
  }

  const hit = targetResolution.hit;

  if (!hit) {
    return { handled: false };
  }

  const resolvedServiceDetailResult = await handleResolvedServiceDetail({
    pool,
    userInput,
    idiomaDestino,
    intentOut,
    hit,
    traducirMensaje,
    convoCtx,
  });

  if (resolvedServiceDetailResult.handled) {
    return resolvedServiceDetailResult;
  }

  return { handled: false };
}