import type { Pool } from "pg";
import type { Lang } from "../../../channels/engine/clients/clientDb";
import type { FastpathCtx } from "../../runFastpath";

type BuildCatalogRoutingSignalFn = (args: {
  intentOut: string | null;
  catalogReferenceClassification: any;
  convoCtx: any;
}) => {
  routeIntent?: string | null;
};

type ResolveBestLinkForServiceResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason?: string;
      options?: Array<{ label: string; url?: string | null }>;
    };

type HandleInterestToLinkInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: Lang;
  detectedIntent?: string | null;
  intentOut?: string | null;
  catalogReferenceClassification?: any;
  convoCtx: Partial<FastpathCtx> | null | undefined;

  buildCatalogRoutingSignal: BuildCatalogRoutingSignalFn;
  resolveBestLinkForService: (args: {
    pool: Pool;
    tenantId: string;
    serviceId: string;
    userText: string;
  }) => Promise<ResolveBestLinkForServiceResult>;
  getServiceDetailsText: (
    tenantId: string,
    serviceId: string,
    userInput: string
  ) => Promise<any>;
  getServiceAndVariantUrl: (
    pool: Pool,
    tenantId: string,
    serviceId: string,
    variantId?: string | null
  ) => Promise<{
    serviceUrl?: string | null;
    variantUrl?: string | null;
  }>;

};

type HandleInterestToLinkResult =
  | { handled: false }
  | {
      handled: true;
      reply: string;
      source: "service_list_db";
      intent: string;
      ctxPatch?: Partial<FastpathCtx>;
    };

function shouldSkipBecauseJustSentDetails(
  convoCtx: Partial<FastpathCtx> | null | undefined
): boolean {
  const lastAct = String(convoCtx?.last_bot_action || "");
  const lastActAt = Number(convoCtx?.last_bot_action_at || 0);

  return (
    lastAct === "sent_details" &&
    lastActAt > 0 &&
    Date.now() - lastActAt < 2 * 60 * 1000 &&
    !Boolean(convoCtx?.pending_link_lookup)
  );
}

function wantsInterestToLink(args: {
  detectedIntent?: string | null;
  catalogReferenceClassification?: any;
  convoCtx: Partial<FastpathCtx> | null | undefined;
  buildCatalogRoutingSignal: BuildCatalogRoutingSignalFn;
}): boolean {
  const {
    detectedIntent,
    catalogReferenceClassification,
    convoCtx,
    buildCatalogRoutingSignal,
  } = args;

  const catalogRouteIntent = buildCatalogRoutingSignal({
    intentOut: detectedIntent || null,
    catalogReferenceClassification,
    convoCtx,
  }).routeIntent;

  return (
    Boolean(convoCtx?.pending_link_lookup) ||
    (Boolean(convoCtx?.last_service_id) &&
      (
        catalogRouteIntent === "catalog_price" ||
        catalogRouteIntent === "catalog_alternatives" ||
        catalogRouteIntent === "catalog_schedule" ||
        String(detectedIntent || "").trim().toLowerCase() === "precio"
      ))
  );
}

function buildAmbiguousReply(args: {
  idiomaDestino: Lang;
  labels: string[];
}): string {
  const { idiomaDestino, labels } = args;

  return idiomaDestino === "en"
    ? `Sure 😊 Which option do you want— ${labels.join(" or ")}?`
    : `Perfecto 😊 ¿Cuál opción quieres— ${labels.join(" o ")}?`;
}

export async function handleInterestToLink(
  input: HandleInterestToLinkInput
): Promise<HandleInterestToLinkResult> {
  const {
    pool,
    tenantId,
    userInput,
    idiomaDestino,
    detectedIntent,
    intentOut,
    catalogReferenceClassification,
    convoCtx,
    buildCatalogRoutingSignal,
    resolveBestLinkForService,
    getServiceDetailsText,
    getServiceAndVariantUrl,
  } = input;

  if (shouldSkipBecauseJustSentDetails(convoCtx)) {
    return { handled: false };
  }

  const pending = Boolean(convoCtx?.pending_link_lookup);
  const shouldHandle = wantsInterestToLink({
    detectedIntent,
    catalogReferenceClassification,
    convoCtx,
    buildCatalogRoutingSignal,
  });

  if (!(shouldHandle || pending) || !convoCtx?.last_service_id) {
    return { handled: false };
  }

  const serviceId = String(convoCtx.last_service_id);
  const baseName = String(convoCtx?.last_service_name || "").trim();

  const pick = await resolveBestLinkForService({
    pool,
    tenantId,
    serviceId,
    userText: userInput,
  });

  if (pick.ok) {
    const d = await getServiceDetailsText(tenantId, serviceId, userInput).catch(
      () => null
    );

    const title = d?.titleSuffix
      ? `${baseName || ""}${baseName ? " — " : ""}${String(d.titleSuffix).trim()}`
      : baseName;

    const infoText = d?.text ? String(d.text).trim() : "";

    const variantId =
      (convoCtx as any)?.last_variant_id
        ? String((convoCtx as any).last_variant_id)
        : null;

    let finalUrl: string | null = null;

    try {
      const urls = await getServiceAndVariantUrl(pool, tenantId, serviceId, variantId);
      finalUrl = urls?.variantUrl || urls?.serviceUrl || null;
    } catch (e: any) {
      console.warn(
        "⚠️ handleInterestToLink: no se pudo adjuntar URL de servicio:",
        e?.message
      );
    }

    const canonicalLines = [
      title ? `• ${title}` : "",
      infoText ? `• ${infoText}` : "",
      pick.url ? `• ${pick.url}` : "",
      finalUrl && finalUrl !== pick.url ? `• ${finalUrl}` : "",
    ].filter(Boolean);

    const canonicalReply = canonicalLines.join("\n");

    return {
      handled: true,
      reply: canonicalReply,
      source: "service_list_db",
      intent: intentOut || "link",
      ctxPatch: {
        last_bot_action: "sent_link_with_details",
        last_bot_action_at: Date.now(),
        pending_link_lookup: undefined,
        pending_link_at: undefined,
        pending_link_options: undefined,
      },
    };
  }

  if (!pick.ok && pick.reason === "ambiguous") {
    const normalizedOptions = (pick.options || [])
      .map((o) => ({
        label: String(o?.label || "").trim(),
        url: o?.url ? String(o.url).trim() : "",
      }))
      .filter((o) => o.label && o.url);

    const labels = normalizedOptions
      .slice(0, 3)
      .map((o) => o.label)
      .filter(Boolean);

    if (!labels.length) {
      return { handled: false };
    }

    return {
      handled: true,
      reply: buildAmbiguousReply({
        idiomaDestino,
        labels,
      }),
      source: "service_list_db",
      intent: intentOut || "link",
      ctxPatch: {
        pending_link_lookup: true,
        pending_link_at: Date.now(),
        pending_link_options: normalizedOptions,
      },
    };
  }

  return { handled: false };
}