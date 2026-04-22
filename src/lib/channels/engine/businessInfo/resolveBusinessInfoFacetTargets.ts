// src/lib/channels/engine/businessInfo/resolveBusinessInfoFacetTargets.ts
import type { Pool } from "pg";
import type { IntentRoutingHints } from "../../../detectarIntencion";
import { resolveServiceCandidatesFromText } from "../../../services/pricing/resolveServiceIdFromText";
import { resolveScheduleGroupKeyFromInfoClave } from "./resolveScheduleGroupKeyFromInfoClave";

export type BusinessInfoScheduleTarget =
  | { type: "none" }
  | { type: "general" }
  | {
      type: "schedule_group";
      serviceId: string;
      serviceName: string;
      scheduleGroupKey: string;
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
  infoClave: string;
  facets: {
    asksSchedules?: boolean;
    asksLocation?: boolean;
    asksAvailability?: boolean;
  };
  routingHints?: IntentRoutingHints | null;
};

function hasMeaningfulFacets(
  args: ResolveBusinessInfoFacetTargetsArgs
): boolean {
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

function hasExplicitGeneralScheduleScope(
  args: ResolveBusinessInfoFacetTargetsArgs
): boolean {
  const scope = String(args.routingHints?.businessInfoScope || "")
    .trim()
    .toLowerCase();

  return scope === "schedule" || scope === "overview";
}

function hasExplicitGeneralLocationScope(
  args: ResolveBusinessInfoFacetTargetsArgs
): boolean {
  const scope = String(args.routingHints?.businessInfoScope || "")
    .trim()
    .toLowerCase();

  return scope === "location" || scope === "overview";
}

function hasExplicitGeneralAvailabilityScope(
  args: ResolveBusinessInfoFacetTargetsArgs
): boolean {
  const scope = String(args.routingHints?.businessInfoScope || "")
    .trim()
    .toLowerCase();

  return scope === "availability" || scope === "overview";
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
      const scheduleGroupKey = await resolveScheduleGroupKeyFromInfoClave({
        pool: args.pool,
        tenantId: args.tenantId,
        infoClave: args.infoClave,
        serviceId: resolved.hit.id,
      });

      if (scheduleGroupKey) {
        targets.scheduleTarget = {
          type: "schedule_group",
          serviceId: resolved.hit.id,
          serviceName: resolved.hit.name,
          scheduleGroupKey,
        };
      } else {
        targets.scheduleTarget = { type: "none" };
      }
    } else if (hasExplicitGeneralScheduleScope(args)) {
      targets.scheduleTarget = { type: "general" };
    } else {
      targets.scheduleTarget = { type: "none" };
    }
  }

  if (args.facets.asksLocation === true) {
    targets.locationTarget = hasExplicitGeneralLocationScope(args)
      ? { type: "general" }
      : { type: "none" };
  }

  if (args.facets.asksAvailability === true) {
    targets.availabilityTarget = hasExplicitGeneralAvailabilityScope(args)
      ? { type: "general" }
      : { type: "none" };
  }

  return targets;
}