//src/lib/fastpath/handlers/catalog/handleResolvedServiceDetail.ts
import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";

export type HandleResolvedServiceDetailInput = {
  pool: Pool;
  userInput: string;
  idiomaDestino: string;
  intentOut?: string | null;
  hit: any;
  traducirMensaje: (texto: string, idiomaDestino: string) => Promise<string>;
  convoCtx: any;
};

export async function handleResolvedServiceDetail(
  input: HandleResolvedServiceDetailInput
): Promise<FastpathResult> {
  const serviceId = String(input.hit?.serviceId || input.hit?.id || "").trim();

  if (!serviceId) {
    return {
      handled: false,
    };
  }

  const {
    rows: [service],
  } = await input.pool.query<any>(
    `
    SELECT
      id,
      name,
      description,
      service_url
    FROM services
    WHERE id = $1
    LIMIT 1
    `,
    [serviceId]
  );

  if (!service) {
    return {
      handled: false,
    };
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
    [serviceId]
  );

  const baseName = String(service.name || "").trim();
  const serviceDescription = String(service.description || "").trim();
  const serviceUrl = service.service_url
    ? String(service.service_url).trim()
    : null;

  const now = Date.now();

  const variantOptions = variants
    .map((variant: any) => ({
      kind: "variant" as const,
      serviceId,
      variantId: String(variant.id || "").trim(),
      label: String(variant.variant_name || "").trim(),
      serviceName: baseName || null,
      variantName: String(variant.variant_name || "").trim() || null,
    }))
    .filter((option) => option.variantId && option.label);

  if (variantOptions.length > 1) {
    return {
      handled: true,
      reply: "",
      source: "catalog_disambiguation_db",
      intent: "variant_choice",
      catalogPayload: {
        kind: "variant_choice",
        originalIntent: input.intentOut || "info_servicio",
        serviceId,
        serviceName: baseName || null,
        options: variantOptions,
      },
      ctxPatch: {
        expectingVariant: true,
        expectedVariantIntent: input.intentOut || "info_servicio",

        selectedServiceId: serviceId,

        last_service_id: serviceId,
        last_service_name: baseName || null,
        last_service_at: now,

        last_variant_id: null,
        last_variant_name: null,
        last_variant_url: null,
        last_variant_at: null,

        pendingCatalogChoice: {
          kind: "variant_choice",
          originalIntent: input.intentOut || "info_servicio",
          serviceId,
          serviceName: baseName || null,
          options: variantOptions,
          createdAt: now,
        },
        pendingCatalogChoiceAt: now,

        last_bot_action: "catalog_variant_choice_pending",
        last_bot_action_at: now,
      } as any,
    };
  }

  const resolvedVariant =
    variantOptions.length === 1 ? variantOptions[0] : null;

  console.log("[FASTPATH-SERVICE-DETAIL] resolved service detail", {
    userInput: input.userInput,
    serviceId,
    baseName,
    hasServiceUrl: !!serviceUrl,
    resolvedVariantId: resolvedVariant?.variantId || null,
  });

  return {
    handled: true,
    reply: "",
    source: "catalog_db",
    intent: input.intentOut || "info_servicio",
    catalogPayload: {
      kind: "resolved_catalog_answer",
      scope: resolvedVariant ? "variant" : "service",
      serviceId,
      serviceName: baseName || null,
      variantId: resolvedVariant?.variantId || null,
      variantName: resolvedVariant?.variantName || null,
      canonicalBlocks: {
        includesBlock: serviceDescription || null,
        linkBlock: serviceUrl || null,
      },
    },
    ctxPatch: {
      expectingVariant: false,
      expectedVariantIntent: null,

      pendingCatalogChoice: null,
      pendingCatalogChoiceAt: null,

      selectedServiceId: serviceId,

      last_service_id: serviceId,
      last_service_name: baseName || null,
      last_service_at: now,

      last_variant_id: resolvedVariant?.variantId || null,
      last_variant_name: resolvedVariant?.variantName || null,
      last_variant_url: null,
      last_variant_at: resolvedVariant ? now : null,
    } as any,
  };
}