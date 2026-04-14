// src/lib/channels/engine/businessInfo/resolveBusinessInfoFacetTargets.ts
import type { Pool } from "pg";
import {
  resolveServiceCandidatesFromText,
  type ResolveServiceDecision,
} from "../../../services/pricing/resolveServiceIdFromText";

export type BusinessInfoScheduleTarget =
  | { type: "none" }
  | { type: "general" }
  | {
      type: "service";
      serviceId: string;
      serviceName: string | null;
    };

export type BusinessInfoLocationTarget =
  | { type: "none" }
  | { type: "general" };

export type BusinessInfoAvailabilityTarget =
  | { type: "none" }
  | { type: "general" };

export type BusinessInfoFacetTargets = {
  scheduleTarget: BusinessInfoScheduleTarget;
  locationTarget: BusinessInfoLocationTarget;
  availabilityTarget: BusinessInfoAvailabilityTarget;
};

type ResolveBusinessInfoFacetTargetsArgs = {
  pool: Pool;
  tenantId: string;
  userInput: string;
  facets: {
    asksSchedules?: boolean;
    asksLocation?: boolean;
    asksAvailability?: boolean;
  };
};

function hasMeaningfulFacets(args: ResolveBusinessInfoFacetTargetsArgs): boolean {
  return (
    args.facets.asksSchedules === true ||
    args.facets.asksLocation === true ||
    args.facets.asksAvailability === true
  );
}

function buildDefaultTargets(): BusinessInfoFacetTargets {
  return {
    scheduleTarget: { type: "none" },
    locationTarget: { type: "none" },
    availabilityTarget: { type: "none" },
  };
}

function shouldPromoteScheduleToServiceTarget(
  resolution: ResolveServiceDecision
): boolean {
  if (resolution.kind !== "resolved_single" || !resolution.hit) {
    return false;
  }

  const best = Array.isArray(resolution.candidates) ? resolution.candidates[0] : null;
  if (!best) {
    return false;
  }

  const overlapNameTokens = Array.isArray(best.overlapNameTokens)
    ? best.overlapNameTokens.filter(Boolean)
    : [];

  // Regla conservadora:
  // solo promovemos un target específico cuando hay evidencia nominal explícita
  // suficiente para no adivinar una modalidad/servicio.
  return overlapNameTokens.length >= 1;
}

export async function resolveBusinessInfoFacetTargets(
  args: ResolveBusinessInfoFacetTargetsArgs
): Promise<BusinessInfoFacetTargets> {
  const targets = buildDefaultTargets();

  if (!hasMeaningfulFacets(args)) {
    return targets;
  }

  if (args.facets.asksLocation === true) {
    targets.locationTarget = { type: "general" };
  }

  if (args.facets.asksAvailability === true) {
    targets.availabilityTarget = { type: "general" };
  }

  if (args.facets.asksSchedules !== true) {
    return targets;
  }

  const resolution = await resolveServiceCandidatesFromText(
    args.pool,
    args.tenantId,
    args.userInput,
    { mode: "strict" }
  );

  if (
    shouldPromoteScheduleToServiceTarget(resolution) &&
    resolution.kind === "resolved_single" &&
    resolution.hit
  ) {
    targets.scheduleTarget = {
      type: "service",
      serviceId: resolution.hit.id,
      serviceName: resolution.hit.name || null,
    };
    return targets;
  }

  targets.scheduleTarget = { type: "general" };
  return targets;
}