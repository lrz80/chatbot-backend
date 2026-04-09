// src/lib/channels/engine/fastpath/getFastpathPostRunDecision.ts
import type { Canal } from "../../../detectarIntencion";

export type FastpathSemanticTurn = {
  domain: "catalog" | "business_info" | "booking" | "other";
  scope: "overview" | "family" | "service" | "variant" | "none";
  answerKind:
    | "price"
    | "includes"
    | "schedule"
    | "location"
    | "availability"
    | "comparison"
    | "overview"
    | "other";
  resolution: "resolved" | "ambiguous" | "unresolved" | "overview";
  grounded: boolean;
};

export type GetFastpathPostRunDecisionInput = {
  canal: Canal;
  fp: {
    source?: string | null;
    intent?: string | null;
    reply?: string | null;
  };
  semanticTurn: FastpathSemanticTurn;
  convoCtx?: any;
  structuredService: {
    hasResolution: boolean;
  };
};

export type GetFastpathPostRunDecisionResult = {
  isDmChannel: boolean;
  shouldReturnRawFastpathForPriceQuestion: boolean;
  shouldNaturalizeSecondaryOptions: boolean;
  shouldReturnRawFastpathForUnresolvedServiceIntent: boolean;
};

function toNormalizedString(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isDmChatChannel(canal: Canal): boolean {
  const normalized = toNormalizedString(canal);
  return (
    normalized === "whatsapp" ||
    normalized === "facebook" ||
    normalized === "instagram"
  );
}

export function getFastpathPostRunDecision(
  input: GetFastpathPostRunDecisionInput
): GetFastpathPostRunDecisionResult {
  const isDmChannel = isDmChatChannel(input.canal);

  const isPriceQuestionUser =
    input.semanticTurn.domain === "catalog" &&
    input.semanticTurn.answerKind === "price";

  const wantsPlansAndHours =
    input.semanticTurn.domain === "catalog" &&
    input.semanticTurn.answerKind === "schedule";

  const isCatalogDetailQuestion =
    input.semanticTurn.domain === "catalog" &&
    (
      input.semanticTurn.answerKind === "includes" ||
      input.semanticTurn.scope === "service" ||
      input.semanticTurn.scope === "variant"
    );

  const shouldReturnRawFastpathForPriceQuestion =
    isDmChannel &&
    isPriceQuestionUser &&
    !wantsPlansAndHours &&
    !isCatalogDetailQuestion &&
    input.semanticTurn.grounded !== true;

  const isPlansList =
    toNormalizedString(input.fp?.source) === "service_list_db" &&
    (input.convoCtx as any)?.last_list_kind === "plan";

  const hasPackagesAvailable =
    (input.convoCtx as any)?.has_packages_available === true;

  const shouldNaturalizeSecondaryOptions =
    toNormalizedString(input.canal) !== "whatsapp" &&
    isPlansList &&
    hasPackagesAvailable;

  const isExplicitServiceDetailTurn =
    input.semanticTurn.domain === "catalog" &&
    input.semanticTurn.resolution !== "overview" &&
    (
      input.semanticTurn.scope === "service" ||
      input.semanticTurn.scope === "variant" ||
      input.semanticTurn.answerKind === "includes"
    );

  const isInfoGeneralOverviewTurn =
    input.semanticTurn.domain === "business_info" &&
    input.semanticTurn.answerKind === "overview";

  const shouldReturnRawFastpathForUnresolvedServiceIntent =
    isDmChannel &&
    !isInfoGeneralOverviewTurn &&
    isExplicitServiceDetailTurn &&
    (
      input.semanticTurn.resolution !== "resolved" ||
      !input.structuredService?.hasResolution
    );

  return {
    isDmChannel,
    shouldReturnRawFastpathForPriceQuestion,
    shouldNaturalizeSecondaryOptions,
    shouldReturnRawFastpathForUnresolvedServiceIntent,
  };
}