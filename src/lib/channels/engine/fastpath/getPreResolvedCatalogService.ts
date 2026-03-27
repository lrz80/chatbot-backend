import type { Pool } from "pg";
import { resolveServiceCandidatesFromText } from "../../../services/pricing/resolveServiceIdFromText";

export type GetPreResolvedCatalogServiceInput = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  convoCtx: any;
  catalogReferenceClassification: any;
  routingPolicy: {
    shouldUseRoutingStructuredService: boolean;
  };
  referentialFollowup?: boolean;
  followupNeedsAnchor?: boolean;
  followupEntityKind?: "service" | "plan" | "package" | null;
};

export type GetPreResolvedCatalogServiceResult = {
  convoCtxForFastpath: any;
  preResolvedCtxPatch: any;
  forcedAnchorCtxPatch: any;
  explicitServiceResolved: boolean;
  explicitResolvedServiceId: string | null;
  explicitResolvedServiceName: string | null;
};

function firstNonEmptyString(...values: any[]): string | null {
  for (const value of values) {
    const v = String(value ?? "").trim();
    if (v) return v;
  }
  return null;
}

export async function getPreResolvedCatalogService(
  input: GetPreResolvedCatalogServiceInput
): Promise<GetPreResolvedCatalogServiceResult> {
  const {
    pool,
    tenantId,
    userInput,
    convoCtx,
    catalogReferenceClassification,
    routingPolicy,
    referentialFollowup,
    followupNeedsAnchor,
    followupEntityKind,
  } = input;

  const preResolvedCtxPatch: any = {};
  const forcedAnchorCtxPatch: any = {};

  let explicitServiceResolved = false;
  let explicitResolvedServiceId: string | null = null;
  let explicitResolvedServiceName: string | null = null;

  const shouldTryPreResolveServiceBase =
    !catalogReferenceClassification?.targetServiceId &&
    routingPolicy.shouldUseRoutingStructuredService &&
    (
      catalogReferenceClassification?.kind === "entity_specific" ||
      catalogReferenceClassification?.kind === "referential_followup" ||
      catalogReferenceClassification?.kind === "variant_specific"
    );

  if (shouldTryPreResolveServiceBase) {
    try {
      const candidateResult = await resolveServiceCandidatesFromText(
        pool,
        tenantId,
        userInput,
        { mode: "loose" }
      );

      const shouldTryPreResolveService =
        Boolean(candidateResult?.hit?.id) &&
        (
          catalogReferenceClassification?.kind === "entity_specific" ||
          catalogReferenceClassification?.kind === "variant_specific" ||
          (
            catalogReferenceClassification?.kind === "referential_followup" &&
            Boolean(
              catalogReferenceClassification?.targetServiceId ||
                convoCtx?.last_service_id ||
                convoCtx?.selectedServiceId
            )
          )
        );

      if (shouldTryPreResolveService && candidateResult?.hit?.id) {
        explicitServiceResolved = true;
        explicitResolvedServiceId = String(candidateResult.hit.id || "").trim();
        explicitResolvedServiceName =
          String(candidateResult.hit.name || "").trim() || null;

        preResolvedCtxPatch.last_service_id = explicitResolvedServiceId;
        preResolvedCtxPatch.last_service_name = explicitResolvedServiceName;
        preResolvedCtxPatch.last_service_label = explicitResolvedServiceName;
        preResolvedCtxPatch.selectedServiceId = explicitResolvedServiceId;
        preResolvedCtxPatch.selectedServiceName = explicitResolvedServiceName;
        preResolvedCtxPatch.selectedServiceLabel = explicitResolvedServiceName;
        preResolvedCtxPatch.last_entity_kind = "service";
        preResolvedCtxPatch.last_entity_at = Date.now();
      }
    } catch (e: any) {
      console.warn(
        "[FASTPATH_HYBRID][PRE_RESOLVE_SERVICE] failed:",
        e?.message || e
      );
    }
  }

  const anchoredServiceId = firstNonEmptyString(
    convoCtx?.selectedServiceId,
    convoCtx?.last_service_id,
    convoCtx?.selected_service_id,
    convoCtx?.serviceId
  );

  const anchoredServiceName = firstNonEmptyString(
    convoCtx?.selectedServiceName,
    convoCtx?.last_service_name,
    convoCtx?.selected_service_name,
    convoCtx?.serviceName
  );

  const anchoredServiceLabel = firstNonEmptyString(
    convoCtx?.selectedServiceLabel,
    convoCtx?.last_service_label,
    convoCtx?.selected_service_label,
    convoCtx?.serviceLabel,
    anchoredServiceName
  );

  const shouldForceAnchoredService =
    shouldTryPreResolveServiceBase &&
    !explicitServiceResolved &&
    Boolean(anchoredServiceId) &&
    (followupNeedsAnchor === true || referentialFollowup === true) &&
    (!followupEntityKind || followupEntityKind === "service");

  if (shouldForceAnchoredService) {
    forcedAnchorCtxPatch.last_service_id = anchoredServiceId;
    forcedAnchorCtxPatch.selectedServiceId = anchoredServiceId;
    forcedAnchorCtxPatch.last_service_name = anchoredServiceName || null;
    forcedAnchorCtxPatch.last_service_label =
      anchoredServiceLabel || anchoredServiceName || null;
    forcedAnchorCtxPatch.last_entity_kind = "service";
    forcedAnchorCtxPatch.last_entity_at = Date.now();
  }

  const convoCtxForFastpath = {
    ...(convoCtx || {}),
    ...forcedAnchorCtxPatch,
    ...preResolvedCtxPatch,
  };

  return {
    convoCtxForFastpath,
    preResolvedCtxPatch,
    forcedAnchorCtxPatch,
    explicitServiceResolved,
    explicitResolvedServiceId,
    explicitResolvedServiceName,
  };
}