// src/lib/channels/engine/businessInfo/resolveBusinessInfoFacetsCanonicalBody.ts
import type { Pool } from "pg";
import type { Canal, IntentRoutingHints } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { withSectionTitle } from "../../../fastpath/handlers/catalog/helpers/catalogReplyBlocks";
import {
  buildAvailabilityBlockFromInfoClave,
  buildLocationBlockFromInfoClave,
} from "../../../fastpath/handlers/catalog/helpers/catalogBusinessInfoBlocks";
import { buildScheduleBlock } from "../../../fastpath/handlers/catalog/helpers/catalogScheduleBlock";
import {
  resolveBusinessInfoFacetTargets,
  type BusinessInfoScheduleTarget,
} from "./resolveBusinessInfoFacetTargets";

type Args = {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  promptBaseMem: string;
  infoClave: string;
  convoCtx?: any;
  facets: {
    asksSchedules?: boolean;
    asksLocation?: boolean;
    asksAvailability?: boolean;
  };
  routingHints?: IntentRoutingHints | null;
};

type EffectiveFacets = {
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
};

function resolveContinuationBusinessInfoFacets(
  convoCtx?: any
): EffectiveFacets | null {
  const lastTurn = convoCtx?.continuationContext?.lastTurn ?? null;

  if (!lastTurn || lastTurn.domain !== "business_info") {
    return null;
  }

  const lastIntent = String(lastTurn.intent || "").trim().toLowerCase();

  if (lastIntent === "horario") {
    return {
      asksSchedules: true,
      asksLocation: false,
      asksAvailability: false,
    };
  }

  if (lastIntent === "ubicacion") {
    return {
      asksSchedules: false,
      asksLocation: true,
      asksAvailability: false,
    };
  }

  if (lastIntent === "disponibilidad") {
    return {
      asksSchedules: false,
      asksLocation: false,
      asksAvailability: true,
    };
  }

  return null;
}

function resolveEffectiveFacets(input: {
  facets: Args["facets"];
  convoCtx?: any;
}): EffectiveFacets {
  const explicitFacets: EffectiveFacets = {
    asksSchedules: input.facets.asksSchedules === true,
    asksLocation: input.facets.asksLocation === true,
    asksAvailability: input.facets.asksAvailability === true,
  };

  const hasExplicitFacet =
    explicitFacets.asksSchedules ||
    explicitFacets.asksLocation ||
    explicitFacets.asksAvailability;

  if (hasExplicitFacet) {
    return explicitFacets;
  }

  const continuationFacets = resolveContinuationBusinessInfoFacets(
    input.convoCtx
  );

  if (continuationFacets) {
    return continuationFacets;
  }

  return explicitFacets;
}

function resolveEffectiveScheduleTarget(input: {
  asksSchedules: boolean;
  scheduleTarget: BusinessInfoScheduleTarget | { type: string } | null | undefined;
}): BusinessInfoScheduleTarget | null {
  if (!input.asksSchedules) {
    return null;
  }

  const currentType = String(input.scheduleTarget?.type || "").trim().toLowerCase();

  if (currentType && currentType !== "none") {
    return input.scheduleTarget as BusinessInfoScheduleTarget;
  }

  return {
    type: "general",
  } as BusinessInfoScheduleTarget;
}

export async function resolveBusinessInfoFacetsCanonicalBody(
  args: Args
): Promise<string> {
  const {
    pool,
    tenantId,
    idiomaDestino,
    infoClave,
    facets,
    userInput,
    convoCtx,
    routingHints,
  } = args;

  const effectiveFacets = resolveEffectiveFacets({
    facets,
    convoCtx,
  });

  const shouldResolveBusinessInfo =
    effectiveFacets.asksSchedules === true ||
    effectiveFacets.asksLocation === true ||
    effectiveFacets.asksAvailability === true;

  if (!shouldResolveBusinessInfo) {
    return "";
  }

  const facetTargets = await resolveBusinessInfoFacetTargets({
    pool,
    tenantId,
    userInput,
    facets: effectiveFacets,
    routingHints: routingHints || null,
  });

  const blocks: string[] = [];

  const effectiveScheduleTarget = resolveEffectiveScheduleTarget({
    asksSchedules: effectiveFacets.asksSchedules,
    scheduleTarget: facetTargets.scheduleTarget,
  });

  if (effectiveFacets.asksSchedules === true && effectiveScheduleTarget) {
    const scheduleBlock = buildScheduleBlock({
      idiomaDestino,
      infoClave,
      scheduleTarget: effectiveScheduleTarget,
    });

    if (String(scheduleBlock || "").trim()) {
      blocks.push(String(scheduleBlock).trim());
    }
  }

  if (
    effectiveFacets.asksLocation === true &&
    facetTargets.locationTarget.type === "general"
  ) {
    const locationBody = buildLocationBlockFromInfoClave(infoClave);

    const locationBlock = withSectionTitle(
      idiomaDestino,
      "Ubicación:",
      "Location:",
      locationBody
    );

    if (String(locationBlock || "").trim()) {
      blocks.push(String(locationBlock).trim());
    }
  }

  if (
    effectiveFacets.asksAvailability === true &&
    facetTargets.availabilityTarget.type === "general"
  ) {
    const availabilityBody = buildAvailabilityBlockFromInfoClave(infoClave);

    const availabilityBlock = withSectionTitle(
      idiomaDestino,
      "Disponibilidad:",
      "Availability:",
      availabilityBody
    );

    if (String(availabilityBlock || "").trim()) {
      blocks.push(String(availabilityBlock).trim());
    }
  }

  return blocks.join("\n\n").trim();
}