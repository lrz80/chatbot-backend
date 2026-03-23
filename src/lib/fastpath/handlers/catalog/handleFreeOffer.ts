import type { Pool } from "pg";
import type { Lang } from "../../../channels/engine/clients/clientDb";
import type { FastpathCtx } from "../../runFastpath";

type FreeOfferRow = {
  id: string;
  name: string | null;
  service_url: string | null;
};

type FreeOfferItem = {
  id: string;
  name: string;
  url: string | null;
};

type HandleFreeOfferInput = {
  pool: Pool;
  tenantId: string;
  idiomaDestino: Lang;
  detectedIntent?: string | null;
  catalogReferenceClassification?: any;
  convoCtx: Partial<FastpathCtx> | null | undefined;
  renderFreeOfferList: (args: {
    lang: Lang;
    items: Array<{ name: string }>;
  }) => string;
};

type HandleFreeOfferResult =
  | { handled: false }
  | {
      handled: true;
      reply: string;
      source: "service_list_db";
      intent: "free_offer";
      ctxPatch?: Partial<FastpathCtx>;
    };

function normalizeValue(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function wantsExplicitFreeOfferTurn(args: {
  detectedIntent?: string | null;
  catalogReferenceClassification?: any;
}): boolean {
  const detectedIntent = normalizeValue(args.detectedIntent);
  const classificationIntent = normalizeValue(
    args.catalogReferenceClassification?.intent
  );
  const referenceKind = normalizeValue(args.catalogReferenceClassification?.kind);

  const hasExplicitFreeIntent =
    detectedIntent === "free_offer" ||
    detectedIntent === "trial" ||
    detectedIntent === "clase_prueba" ||
    detectedIntent === "free_trial";

  const hasExplicitFreeClassification =
    classificationIntent === "free_offer" ||
    classificationIntent === "trial" ||
    classificationIntent === "clase_prueba" ||
    classificationIntent === "free_trial";

  const hasCompatibleReferenceKind =
    referenceKind === "entity_specific" ||
    referenceKind === "variant_specific" ||
    referenceKind === "referential_followup" ||
    referenceKind === "catalog_overview" ||
    referenceKind === "catalog_family";

  return (
    (hasExplicitFreeIntent || hasExplicitFreeClassification) &&
    hasCompatibleReferenceKind
  );
}

async function loadFreeOfferItems(
  pool: Pool,
  tenantId: string
): Promise<FreeOfferItem[]> {
  const { rows } = await pool.query<FreeOfferRow>(
    `
    SELECT s.id, s.name, s.service_url
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = true
      AND COALESCE(s.price_base, 0) <= 0
      AND s.service_url IS NOT NULL
      AND length(trim(s.service_url)) > 0
    ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
    LIMIT 10
    `,
    [tenantId]
  );

  return (rows || [])
    .map((r) => ({
      id: String(r.id),
      name: String(r.name || "").trim(),
      url: r.service_url ? String(r.service_url).trim() : null,
    }))
    .filter((x) => x.name && x.url);
}

function buildNoItemsReply(idiomaDestino: Lang): string {
  return idiomaDestino === "en"
    ? "Yes — we can help with a free/trial option 😊 What exactly are you looking for?"
    : "Sí — podemos ayudarte con una opción gratis/de prueba 😊 ¿Qué estás buscando exactamente?";
}

function buildSingleItemReply(item: FreeOfferItem): string {
  return `${item.name}\n${item.url}`;
}

export async function handleFreeOffer(
  input: HandleFreeOfferInput
): Promise<HandleFreeOfferResult> {
  const {
    pool,
    tenantId,
    idiomaDestino,
    detectedIntent,
    catalogReferenceClassification,
    renderFreeOfferList,
  } = input;

  const shouldHandle = wantsExplicitFreeOfferTurn({
    detectedIntent,
    catalogReferenceClassification,
  });

  if (!shouldHandle) {
    return { handled: false };
  }

  const items = await loadFreeOfferItems(pool, tenantId);

  if (!items.length) {
    return {
      handled: true,
      reply: buildNoItemsReply(idiomaDestino),
      source: "service_list_db",
      intent: "free_offer",
    };
  }

  if (items.length === 1) {
    const one = items[0];

    return {
      handled: true,
      reply: buildSingleItemReply(one),
      source: "service_list_db",
      intent: "free_offer",
      ctxPatch: {
        last_service_id: one.id,
        last_service_name: one.name,
        last_service_at: Date.now(),
      },
    };
  }

  const now = Date.now();

  const reply = renderFreeOfferList({
    lang: idiomaDestino,
    items: items.map((x) => ({ name: x.name })),
  });

  return {
    handled: true,
    reply,
    source: "service_list_db",
    intent: "free_offer",
    ctxPatch: {
      last_plan_list: items.map((x) => ({
        id: x.id,
        name: x.name,
        url: x.url,
      })),
      last_plan_list_at: now,
      last_list_kind: "plan",
      last_list_kind_at: now,
    },
  };
}