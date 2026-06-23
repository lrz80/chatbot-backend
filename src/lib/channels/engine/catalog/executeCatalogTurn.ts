//src/lib/channels/engine/catalog/executeCatalogTurn.ts

import type { Pool } from "pg";
import type { Canal, CommercialSignal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { runCatalogDomainTurn } from "../../../fastpath/runCatalogDomainTurn";
import { renderFastpathDmReply } from "../fastpath/renderFastpathDmReply";
import { buildFastpathReplyPolicy } from "../fastpath/buildFastpathReplyPolicy";

type CatalogIntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type ExecuteCatalogTurnArgs = {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  contactoNorm: string;
  messageId: string | null;
  promptBaseMem: string;
  infoClave: string;

  inBooking: boolean;
  convoCtx: any;
  ctxPatch?: any;

  detectedIntent: string | null;
  detectedFacets?: CatalogIntentFacets | null;
  detectedCommercial?: CommercialSignal | null;

  catalogReferenceClassification?: any;
  canonicalCatalogResolution?: {
    resolutionKind: string;
    resolvedServiceId?: string | null;
    resolvedServiceName?: string | null;
    variantOptions?: Array<{
      variantId: string;
      variantName: string;
    }>;
  };

  maxDisambiguationOptions?: number;
  maxLines?: number;
};

type ExecuteCatalogTurnResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string | null;
  ctxPatch?: any;
};

function getCatalogReply(catalogRes: any): string {
  return "reply" in catalogRes && typeof catalogRes.reply === "string"
    ? catalogRes.reply
    : "";
}

function getCatalogPayload(catalogRes: any): any | undefined {
  return "catalogPayload" in catalogRes
    ? catalogRes.catalogPayload ?? undefined
    : undefined;
}

function getCatalogSource(catalogRes: any): string | null {
  return "source" in catalogRes && typeof catalogRes.source === "string"
    ? catalogRes.source
    : null;
}

function getCatalogIntent(catalogRes: any, fallbackIntent: string | null): string | null {
  return "intent" in catalogRes && typeof catalogRes.intent === "string"
    ? catalogRes.intent
    : fallbackIntent;
}

function getCatalogAwaitingEffect(catalogRes: any): any | null {
  return "awaitingEffect" in catalogRes
    ? catalogRes.awaitingEffect ?? null
    : null;
}

function buildStructuredServiceFromCatalogPayload(catalogPayload: any) {
  return {
    serviceId:
      catalogPayload?.kind === "resolved_catalog_answer"
        ? catalogPayload.serviceId || null
        : catalogPayload?.kind === "variant_choice"
        ? catalogPayload.serviceId || null
        : null,

    serviceName:
      catalogPayload?.kind === "resolved_catalog_answer"
        ? catalogPayload.serviceName || null
        : catalogPayload?.kind === "variant_choice"
        ? catalogPayload.serviceName || null
        : null,

    serviceLabel:
      catalogPayload?.kind === "resolved_catalog_answer"
        ? catalogPayload.variantName || catalogPayload.serviceName || null
        : catalogPayload?.kind === "variant_choice"
        ? catalogPayload.serviceName || null
        : null,

    hasResolution:
      catalogPayload?.kind === "resolved_catalog_answer" &&
      (
        Boolean(catalogPayload.serviceId) ||
        Boolean(catalogPayload.variantId)
      ),
  };
}

export async function executeCatalogTurn(
  args: ExecuteCatalogTurnArgs
): Promise<ExecuteCatalogTurnResult> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    infoClave,
    inBooking,
    convoCtx,
    ctxPatch,
    detectedIntent,
    detectedFacets,
    detectedCommercial,
    catalogReferenceClassification,
    canonicalCatalogResolution,
    maxDisambiguationOptions = 10,
    maxLines = 9999,
  } = args;

  const catalogRes = await runCatalogDomainTurn({
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx,
    infoClave,
    detectedIntent,
    detectedFacets: detectedFacets || {},
    catalogReferenceClassification,
    maxDisambiguationOptions,
    catalogRouteContext: {
      canonicalCatalogResolution,
    },
  });

  const nextCtxPatch = {
    ...(ctxPatch || {}),
    ...(catalogRes.ctxPatch || {}),
  };

  if (!catalogRes.handled) {
    return {
      handled: false,
      source: "catalog_not_handled",
      intent: detectedIntent || null,
      ctxPatch: catalogRes.ctxPatch || {},
    };
  }

  const rawCatalogText = String(getCatalogReply(catalogRes) || "").trim();
  const catalogPayload = getCatalogPayload(catalogRes);
  const hasCatalogPayload = Boolean(catalogPayload);

  if (!rawCatalogText && !hasCatalogPayload) {
    return {
      handled: false,
      source: "catalog_empty_reply",
      intent: detectedIntent || null,
      ctxPatch: catalogRes.ctxPatch || {},
    };
  }

  const catalogSource = getCatalogSource(catalogRes);
  const catalogIntent = getCatalogIntent(catalogRes, detectedIntent);
  const catalogAwaitingEffect = getCatalogAwaitingEffect(catalogRes);

  const structuredServiceForRender = {
    serviceId:
      catalogPayload?.kind === "resolved_catalog_answer"
        ? catalogPayload.serviceId || null
        : catalogPayload?.kind === "variant_choice"
        ? catalogPayload.serviceId || null
        : null,

    serviceName:
      catalogPayload?.kind === "resolved_catalog_answer"
        ? catalogPayload.serviceName || null
        : catalogPayload?.kind === "variant_choice"
        ? catalogPayload.serviceName || null
        : null,

    serviceLabel:
      catalogPayload?.kind === "resolved_catalog_answer"
        ? catalogPayload.serviceName || null
        : catalogPayload?.kind === "variant_choice"
        ? catalogPayload.serviceName || null
        : null,

    hasResolution:
      catalogPayload?.kind === "resolved_catalog_answer" &&
      (
        Boolean(catalogPayload.serviceId) ||
        Boolean(catalogPayload.variantId)
      ),
  };

  const structuredServiceForPolicy =
    buildStructuredServiceFromCatalogPayload(catalogPayload);

  const rendered = await renderFastpathDmReply({
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    contactoNorm,
    messageId,
    promptBaseMem,
    fastpathText: rawCatalogText,
    fp: {
      reply: rawCatalogText,
      source: catalogSource || "catalog_route",
      intent: catalogIntent,
      awaitingEffect: catalogAwaitingEffect,
      catalogPayload,
    },
    detectedIntent: catalogIntent,
    intentFallback: catalogIntent,
    structuredService: structuredServiceForRender,
    replyPolicy: buildFastpathReplyPolicy({
      canal,
      fp: {
        handled: true,
        source: catalogSource || "catalog_route",
        intent: catalogIntent,
        reply: rawCatalogText,
        ctxPatch: nextCtxPatch || {},
        awaitingEffect: catalogAwaitingEffect,
      },
      detectedIntent: catalogIntent,
      intentFallback: catalogIntent,
      detectedCommercial,
      catalogRoutingSignal: catalogReferenceClassification ?? null,
      catalogReferenceClassification: catalogReferenceClassification ?? null,
      structuredService: structuredServiceForPolicy,
      ctxPatch: nextCtxPatch || {},
    }),
    ctxPatch: nextCtxPatch || {},
    maxLines,
  });

  const reply = String(rendered.reply || "").trim();

  if (!reply) {
    return {
      handled: false,
      source: "catalog_render_empty",
      intent: catalogIntent || null,
      ctxPatch: {
        ...(catalogRes.ctxPatch || {}),
        ...(rendered.ctxPatch || {}),
      },
    };
  }

  return {
    handled: true,
    reply,
    source: catalogSource || "catalog_route",
    intent: catalogIntent || null,
    ctxPatch: {
      ...(catalogRes.ctxPatch || {}),
      ...(rendered.ctxPatch || {}),
    },
  };
}