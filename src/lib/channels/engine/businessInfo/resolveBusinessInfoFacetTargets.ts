// src/lib/channels/engine/businessInfo/resolveBusinessInfoFacetTargets.ts
import type { Pool } from "pg";
import { resolveServiceCandidatesFromText } from "../../../services/pricing/resolveServiceIdFromText";

export type BusinessInfoScheduleTarget =
  | { type: "none" }
  | { type: "general" }
  | { type: "service"; serviceId: string; serviceName: string };

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

export async function resolveBusinessInfoFacetTargets(
  args: ResolveBusinessInfoFacetTargetsArgs
): Promise<BusinessInfoFacetTargets> {
  const targets = buildDefaultTargets();

  if (!hasMeaningfulFacets(args)) {
    return targets;
  }

  if (args.facets.asksSchedules === true) {
    const resolved = await resolveServiceCandidatesFromText(
      args.pool,
      args.tenantId,
      args.userInput,
      { mode: "loose" }
    );

    if (resolved.kind === "resolved_single" && resolved.hit) {
      targets.scheduleTarget = {
        type: "service",
        serviceId: resolved.hit.id,
        serviceName: resolved.hit.name,
      };
    } else {
      targets.scheduleTarget = { type: "general" };
    }
  }

  if (args.facets.asksLocation === true) {
    targets.locationTarget = { type: "general" };
  }

  if (args.facets.asksAvailability === true) {
    targets.availabilityTarget = { type: "general" };
  }

  return targets;
}