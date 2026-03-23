import type { Pool } from "pg";
import type { Lang } from "../../../channels/engine/clients/clientDb";
import type { FastpathCtx } from "../../runFastpath";

type ResolveFirstTurnServiceDetailTargetInput = {
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
};

type ResolveFirstTurnServiceDetailTargetResult =
  | { handled: false; hit: any | null }
  | {
      handled: true;
      reply: string;
      source: "service_list_db";
      intent: "info_servicio";
      ctxPatch: Partial<FastpathCtx>;
    };

type ServiceCandidateRow = {
  id: string;
  name: string | null;
};

async function tryResolveLooseServiceHit(args: {
  pool: Pool;
  tenantId: string;
  userInput: string;
  resolveServiceIdFromText: (
    pool: Pool,
    tenantId: string,
    text: string,
    opts?: any
  ) => Promise<any>;
}) {
  const { pool, tenantId, userInput, resolveServiceIdFromText } = args;

  return await resolveServiceIdFromText(pool, tenantId, userInput, {
    mode: "loose",
  });
}

function canUseCatalogTargetFallback(
  normalizeText: (input: string) => string,
  userInput: string
) {
  const textForToken = normalizeText(userInput);
  const tokenWordCount = textForToken.split(/\s+/).filter(Boolean).length;

  return {
    textForToken,
    canUseFallback: tokenWordCount <= 6 && !textForToken.includes("\n"),
  };
}

function getPlanToken(args: {
  canUseFallback: boolean;
  catalogReferenceClassification?: any;
  convoCtx: Partial<FastpathCtx> | null | undefined;
}) {
  const { canUseFallback, catalogReferenceClassification, convoCtx } = args;

  if (!canUseFallback) return null;

  return (
    catalogReferenceClassification?.targetServiceId ||
    catalogReferenceClassification?.targetVariantId ||
    catalogReferenceClassification?.targetFamilyKey ||
    convoCtx?.last_service_id ||
    convoCtx?.last_variant_id ||
    convoCtx?.last_family_key ||
    null
  );
}

async function loadPlanTokenCandidates(args: {
  pool: Pool;
  tenantId: string;
  planToken: string;
}): Promise<ServiceCandidateRow[]> {
  const { pool, tenantId, planToken } = args;

  const { rows } = await pool.query<ServiceCandidateRow>(
    `
    SELECT id, name
    FROM services
    WHERE tenant_id = $1
      AND active = true
      AND lower(name) LIKE $2
    ORDER BY created_at ASC
    LIMIT 5
    `,
    [tenantId, `%${String(planToken).toLowerCase()}%`]
  );

  return rows;
}

function buildPlanGroupDisambiguationReply(args: {
  idiomaDestino: Lang;
  rows: ServiceCandidateRow[];
}) {
  const { idiomaDestino, rows } = args;

  return idiomaDestino === "en"
    ? `Just to confirm 😊 are you asking about:\n\n${rows
        .map((r, i) => `• ${i + 1}) ${String(r.name || "").trim()}`)
        .join("\n")}\n\nReply with the number or the name and I'll tell you what it includes.`
    : `Solo para confirmar 😊 ¿te refieres a:\n\n${rows
        .map((r, i) => `• ${i + 1}) ${String(r.name || "").trim()}`)
        .join("\n")}\n\nRespóndeme con el número o el nombre y te explico qué incluye.`;
}

function normalizeVariantHitToServiceHit(hit: any) {
  if (!hit) return null;

  if (hit.isVariant) {
    const serviceOfVariant = hit.service_id;

    return {
      id: serviceOfVariant,
      name: hit.parent_service_name,
    };
  }

  return hit;
}

function hasExplicitNewTarget(args: {
  catalogReferenceClassification?: any;
  convoCtx: Partial<FastpathCtx> | null | undefined;
}) {
  const { catalogReferenceClassification, convoCtx } = args;

  const explicitGroupToken =
    catalogReferenceClassification?.targetFamilyKey ||
    catalogReferenceClassification?.targetServiceId ||
    catalogReferenceClassification?.targetVariantId ||
    convoCtx?.last_family_key ||
    convoCtx?.last_service_id ||
    convoCtx?.last_variant_id ||
    null;

  return !!explicitGroupToken;
}

function resolveFromContextFallback(
  convoCtx: Partial<FastpathCtx> | null | undefined
) {
  if (convoCtx?.last_plan_list?.length === 1) {
    return {
      id: convoCtx.last_plan_list[0].id,
      name: convoCtx.last_plan_list[0].name,
    };
  }

  if (convoCtx?.selectedServiceId) {
    return {
      id: convoCtx.selectedServiceId,
      name: convoCtx.last_service_name || "",
    };
  }

  if (convoCtx?.last_service_id) {
    return {
      id: convoCtx.last_service_id,
      name: convoCtx.last_service_name || "",
    };
  }

  return null;
}

export async function resolveFirstTurnServiceDetailTarget(
  input: ResolveFirstTurnServiceDetailTargetInput
): Promise<ResolveFirstTurnServiceDetailTargetResult> {
  const {
    pool,
    tenantId,
    userInput,
    idiomaDestino,
    convoCtx,
    catalogReferenceClassification,
    normalizeText,
    resolveServiceIdFromText,
  } = input;

  let hit: any = await tryResolveLooseServiceHit({
    pool,
    tenantId,
    userInput,
    resolveServiceIdFromText,
  });

  if (!hit) {
    const { canUseFallback } = canUseCatalogTargetFallback(normalizeText, userInput);

    const planToken = getPlanToken({
      canUseFallback,
      catalogReferenceClassification,
      convoCtx,
    });

    console.log("[CATALOG_TARGET_TOKEN] userInput =", userInput);
    console.log("[CATALOG_TARGET_TOKEN] canUseFallback =", canUseFallback);
    console.log("[CATALOG_TARGET_TOKEN] extracted =", planToken);

    if (planToken) {
      const rows = await loadPlanTokenCandidates({
        pool,
        tenantId,
        planToken: String(planToken),
      });

      console.log(
        "[CATALOG_TARGET_TOKEN] candidate rows =",
        rows.map((r) => r.name)
      );

      if (rows.length === 1) {
        hit = {
          serviceId: rows[0].id,
          serviceName: rows[0].name,
        };
      }

      if (rows.length > 1) {
        console.log("[FASTPATH_BRANCH] plan_group_disambiguation", {
          userInput,
          candidates: rows.map((r) => r.name),
        });

        return {
          handled: true,
          reply: buildPlanGroupDisambiguationReply({
            idiomaDestino,
            rows,
          }),
          source: "service_list_db",
          intent: "info_servicio",
          ctxPatch: {
            last_plan_list: rows.map((r) => ({
              id: String(r.id),
              name: String(r.name || "").trim(),
              url: null,
            })),
            last_plan_list_at: Date.now(),
            last_list_kind: "plan",
            last_list_kind_at: Date.now(),

            pending_price_lookup: true,
            pending_price_at: Date.now(),
            pending_price_target_text: userInput,
            pending_price_raw_user_text: userInput,

            last_bot_action: "asked_plan_group_disambiguation",
            last_bot_action_at: Date.now(),
          },
        };
      }
    }
  }

  hit = normalizeVariantHitToServiceHit(hit);

  if (!hit && !hasExplicitNewTarget({ catalogReferenceClassification, convoCtx })) {
    hit = resolveFromContextFallback(convoCtx);
  }

  return {
    handled: false,
    hit: hit || null,
  };
}