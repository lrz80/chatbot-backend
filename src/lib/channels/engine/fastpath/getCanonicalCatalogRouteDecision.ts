import type { Pool } from "pg";
import {
  resolveServiceCandidatesFromText,
  type ResolveServiceDecision,
} from "../../../services/pricing/resolveServiceIdFromText";

export type CanonicalCatalogRouteDecision = {
  shouldRouteCatalog: boolean;
  resolutionKind: "resolved_single" | "ambiguous" | "none";
  resolution: ResolveServiceDecision;
};

type Args = {
  pool: Pool;
  tenantId: string;
  userInput: string;
};

export async function getCanonicalCatalogRouteDecision(
  args: Args
): Promise<CanonicalCatalogRouteDecision> {
  const resolution = await resolveServiceCandidatesFromText(
    args.pool,
    args.tenantId,
    args.userInput,
    { mode: "loose" }
  );

  if (resolution.kind === "resolved_single") {
    return {
      shouldRouteCatalog: true,
      resolutionKind: "resolved_single",
      resolution,
    };
  }

  if (resolution.kind === "ambiguous") {
    return {
      shouldRouteCatalog: true,
      resolutionKind: "ambiguous",
      resolution,
    };
  }

  return {
    shouldRouteCatalog: false,
    resolutionKind: "none",
    resolution,
  };
}