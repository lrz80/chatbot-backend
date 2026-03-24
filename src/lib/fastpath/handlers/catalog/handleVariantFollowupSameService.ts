import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";
import { getCatalogStructuredSignals } from "./getCatalogStructuredSignals";

export type HandleVariantFollowupSameServiceInput = {
  pool: Pool;
  userInput: string;
  idiomaDestino: string;
  intentOut?: string | null;
  convoCtx: any;
  catalogReferenceClassification?: any;
  isFreshCatalogPriceTurn: boolean;
  catalogRouteIntent?: string | null;
};

function splitLines(text: string): string[] {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
}

export async function handleVariantFollowupSameService(
  input: HandleVariantFollowupSameServiceInput
): Promise<FastpathResult> {
  if (input.isFreshCatalogPriceTurn) {
    return { handled: false };
  }

  if ((input.convoCtx as any)?.expectingVariant !== true) {
    return { handled: false };
  }

  const {
    targetVariantId,
    targetServiceId,
  } = getCatalogStructuredSignals({
    catalogReferenceClassification: input.catalogReferenceClassification,
    convoCtx: input.convoCtx,
    catalogRouteIntent: input.catalogRouteIntent,
  });

  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;

  const lastServiceId = String(
    targetServiceId || (input.convoCtx as any)?.last_service_id || ""
  ).trim();

  const lastServiceFresh =
    !!lastServiceId &&
    Number((input.convoCtx as any)?.last_service_at || 0) > 0 &&
    now - Number((input.convoCtx as any)?.last_service_at || 0) <= ttlMs;

  const isAwaitingPriceVariantSelection =
    input.convoCtx.expectedVariantIntent === "price_or_plan" &&
    Boolean((input.convoCtx as any)?.expectingVariant) &&
    Array.isArray((input.convoCtx as any)?.last_variant_options) &&
    (input.convoCtx as any).last_variant_options.length > 0;

  if (!lastServiceFresh || isAwaitingPriceVariantSelection) {
    return { handled: false };
  }

  if (!targetVariantId || String(input.userInput || "").trim().length > 6) {
    return { handled: false };
  }

  const { rows: variants } = await input.pool.query<any>(
    `
    SELECT
      id,
      variant_name,
      description,
      variant_url,
      price,
      currency
    FROM service_variants
    WHERE service_id = $1
      AND active = true
    ORDER BY created_at ASC, id ASC
    `,
    [lastServiceId]
  );

  if (!variants.length) {
    return { handled: false };
  }

  const chosen =
    variants.find((v: any) => String(v.id || "") === String(targetVariantId)) ||
    null;

  if (!chosen) {
    return { handled: false };
  }

  const {
    rows: [service],
  } = await input.pool.query<any>(
    `
    SELECT
      name,
      description,
      service_url
    FROM services
    WHERE id = $1
    `,
    [lastServiceId]
  );

  const descSource = String(
    chosen.description || service?.description || ""
  ).trim();

  const link: string | null =
    chosen.variant_url ? String(chosen.variant_url).trim()
    : service?.service_url ? String(service.service_url).trim()
    : null;

  const bullets = splitLines(descSource)
    .map((line: string) => `• ${line}`)
    .join("\n");

  const baseName = String(service?.name || "").trim();
  const variantName = String(chosen.variant_name || "").trim();

  const title =
    baseName && variantName
      ? `${baseName} — ${variantName}`
      : baseName || variantName || "";

  let reply =
    input.idiomaDestino === "en"
      ? `Perfect 😊\n\n${title ? `*${title}*` : ""}${bullets ? ` includes:\n\n${bullets}` : ""}`
      : `Perfecto 😊\n\n${title ? `*${title}*` : ""}${bullets ? ` incluye:\n\n${bullets}` : ""}`;

  if (link) {
    reply +=
      input.idiomaDestino === "en"
        ? `\n\nHere you can see more details:\n${link}`
        : `\n\nAquí puedes ver más detalles:\n${link}`;
  }

  console.log("[FASTPATH-VARIANT-FOLLOWUP] direct variant switch", {
    userInput: input.userInput,
    serviceId: lastServiceId,
    baseName,
    variantName,
    link,
    targetVariantId,
  });

  return {
    handled: true,
    reply,
    source: "service_list_db",
    intent: input.intentOut || "info_servicio",
    ctxPatch: {
      last_service_id: lastServiceId,
      last_service_name: baseName || null,
      last_service_at: Date.now(),

      last_variant_id: String(chosen.id || ""),
      last_variant_name: variantName || null,
      last_variant_url: link || null,
      last_variant_at: Date.now(),

      last_price_option_label: variantName || null,
      last_price_option_at: Date.now(),
    } as any,
  };
}