//src/lib/integrations/square/syncSquareServiceMappingsForTenant.ts
import { upsertTenantExternalServiceMapping } from "../serviceMappings/getTenantExternalServiceMapping";
import { getSquareConnectionForTenant } from "./getSquareConnectionForTenant";
import {
  getSquareBookableServices,
  type SquareBookableService,
} from "./getSquareBookableServices";

export type SyncSquareInternalServiceInput = {
  internalServiceKey: string;
  internalServiceName?: string | null;
};

export type SyncSquareServiceMappingsForTenantInput = {
  tenantId: string;
  internalServices: SyncSquareInternalServiceInput[];
  autoConfirmExactMatches?: boolean;
};

export type SyncedSquareServiceMapping = {
  internalServiceKey: string;
  internalServiceName: string | null;
  externalServiceId: string;
  externalServiceVersion: number | null;
  externalLocationId: string | null;
  externalServiceName: string;
  matchStatus: "confirmed" | "suggested";
  matchConfidence: number;
};

export type SkippedSquareServiceMapping = {
  internalServiceKey: string;
  internalServiceName: string | null;
  reason:
    | "EMPTY_INTERNAL_SERVICE_KEY"
    | "NO_MATCH"
    | "AMBIGUOUS_MATCH"
    | "UPSERT_FAILED";
  details?: unknown;
};

export type SyncSquareServiceMappingsForTenantResult =
  | {
      ok: true;
      synced: SyncedSquareServiceMapping[];
      skipped: SkippedSquareServiceMapping[];
      squareServicesCount: number;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      details?: unknown;
    };

type SquareServiceCandidate = {
  service: SquareBookableService;
  externalServiceId: string;
  externalServiceVersion: number | null;
  externalLocationId: string | null;
  externalServiceName: string;
  normalizedName: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeText(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(clean(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function getSquareServiceName(service: SquareBookableService): string {
  const raw = service as any;

  return (
    clean(raw.name) ||
    clean(raw.serviceName) ||
    clean(raw.itemName) ||
    clean(raw.variationName) ||
    clean(raw.displayName)
  );
}

function getSquareServiceVariationId(service: SquareBookableService): string {
  const raw = service as any;

  return (
    clean(raw.variationId) ||
    clean(raw.serviceVariationId) ||
    clean(raw.externalServiceId) ||
    clean(raw.id)
  );
}

function getSquareServiceVariationVersion(
  service: SquareBookableService
): number | null {
  const raw = service as any;

  return normalizeNumber(
    raw.variationVersion ??
      raw.serviceVariationVersion ??
      raw.version ??
      raw.externalServiceVersion
  );
}

function getSquareServiceLocationId(
  service: SquareBookableService,
  fallbackLocationId: string | null
): string | null {
  const raw = service as any;

  return (
    clean(raw.locationId) ||
    clean(raw.externalLocationId) ||
    clean(raw.location_id) ||
    fallbackLocationId ||
    null
  );
}

function buildCandidates(params: {
  services: SquareBookableService[];
  fallbackLocationId: string | null;
}): SquareServiceCandidate[] {
  return params.services
    .map((service) => {
      const externalServiceId = getSquareServiceVariationId(service);
      const externalServiceName = getSquareServiceName(service);

      if (!externalServiceId || !externalServiceName) {
        return null;
      }

      return {
        service,
        externalServiceId,
        externalServiceVersion: getSquareServiceVariationVersion(service),
        externalLocationId: getSquareServiceLocationId(
          service,
          params.fallbackLocationId
        ),
        externalServiceName,
        normalizedName: normalizeText(externalServiceName),
      };
    })
    .filter((item): item is SquareServiceCandidate => Boolean(item));
}

function findBestMatch(params: {
  internalServiceKey: string;
  internalServiceName: string | null;
  candidates: SquareServiceCandidate[];
}):
  | {
      ok: true;
      candidate: SquareServiceCandidate;
      matchStatus: "confirmed" | "suggested";
      matchConfidence: number;
    }
  | {
      ok: false;
      reason: "NO_MATCH" | "AMBIGUOUS_MATCH";
      details?: unknown;
    } {
  const internalKey = normalizeText(params.internalServiceKey);
  const internalName = normalizeText(params.internalServiceName);
  const searchValues = [internalKey, internalName].filter(Boolean);

  if (searchValues.length === 0) {
    return {
      ok: false,
      reason: "NO_MATCH",
    };
  }

  const exactMatches = params.candidates.filter((candidate) => {
    return searchValues.some((value) => value === candidate.normalizedName);
  });

  if (exactMatches.length === 1) {
    return {
      ok: true,
      candidate: exactMatches[0],
      matchStatus: "confirmed",
      matchConfidence: 1,
    };
  }

  if (exactMatches.length > 1) {
    return {
      ok: false,
      reason: "AMBIGUOUS_MATCH",
      details: {
        matches: exactMatches.map((candidate) => ({
          externalServiceId: candidate.externalServiceId,
          externalServiceName: candidate.externalServiceName,
        })),
      },
    };
  }

  const containsMatches = params.candidates.filter((candidate) => {
    return searchValues.some((value) => {
      return (
        value.length >= 4 &&
        (candidate.normalizedName.includes(value) ||
          value.includes(candidate.normalizedName))
      );
    });
  });

  if (containsMatches.length === 1) {
    return {
      ok: true,
      candidate: containsMatches[0],
      matchStatus: "suggested",
      matchConfidence: 0.75,
    };
  }

  if (containsMatches.length > 1) {
    return {
      ok: false,
      reason: "AMBIGUOUS_MATCH",
      details: {
        matches: containsMatches.map((candidate) => ({
          externalServiceId: candidate.externalServiceId,
          externalServiceName: candidate.externalServiceName,
        })),
      },
    };
  }

  return {
    ok: false,
    reason: "NO_MATCH",
  };
}

export async function syncSquareServiceMappingsForTenant(
  input: SyncSquareServiceMappingsForTenantInput
): Promise<SyncSquareServiceMappingsForTenantResult> {
  const tenantId = clean(input.tenantId);
  const autoConfirmExactMatches = input.autoConfirmExactMatches !== false;

  if (!tenantId) {
    return {
      ok: false,
      error: "MISSING_TENANT_ID",
      status: 400,
    };
  }

  const connectionResult = await getSquareConnectionForTenant(tenantId);

  if (!connectionResult.ok) {
    return connectionResult;
  }

  const servicesResult = await getSquareBookableServices({
    accessToken: connectionResult.connection.accessToken,
    environment: connectionResult.connection.environment,
  });

  if (!servicesResult.ok) {
    return servicesResult;
  }

  const fallbackLocationId =
    clean((connectionResult.connection as any).locationId) ||
    clean((connectionResult.connection as any).externalLocationId) ||
    null;

  const candidates = buildCandidates({
    services: servicesResult.services,
    fallbackLocationId,
  });

  const synced: SyncedSquareServiceMapping[] = [];
  const skipped: SkippedSquareServiceMapping[] = [];

  for (const internalService of input.internalServices || []) {
    const internalServiceKey = clean(internalService.internalServiceKey);
    const internalServiceName = clean(internalService.internalServiceName) || null;

    if (!internalServiceKey) {
      skipped.push({
        internalServiceKey,
        internalServiceName,
        reason: "EMPTY_INTERNAL_SERVICE_KEY",
      });
      continue;
    }

    const match = findBestMatch({
      internalServiceKey,
      internalServiceName,
      candidates,
    });

    if (!match.ok) {
      skipped.push({
        internalServiceKey,
        internalServiceName,
        reason: match.reason,
        details: match.details,
      });
      continue;
    }

    if (match.matchStatus === "suggested" && autoConfirmExactMatches) {
      skipped.push({
        internalServiceKey,
        internalServiceName,
        reason: "AMBIGUOUS_MATCH",
        details: {
          message:
            "Only exact unique matches are auto-confirmed. Suggested matches must be reviewed.",
          suggested: {
            externalServiceId: match.candidate.externalServiceId,
            externalServiceName: match.candidate.externalServiceName,
            matchConfidence: match.matchConfidence,
          },
        },
      });
      continue;
    }

    const upsertResult = await upsertTenantExternalServiceMapping({
      tenantId,
      provider: "square",
      internalServiceKey,
      externalServiceId: match.candidate.externalServiceId,
      externalServiceVersion: match.candidate.externalServiceVersion,
      externalLocationId: match.candidate.externalLocationId,
      externalMetadata: {
        source: "square_sync",
        matchStatus: match.matchStatus,
        matchConfidence: match.matchConfidence,
        externalServiceName: match.candidate.externalServiceName,
        internalServiceName,
        syncedAt: new Date().toISOString(),
      },
      isActive: true,
    });

    if (!upsertResult.ok) {
      skipped.push({
        internalServiceKey,
        internalServiceName,
        reason: "UPSERT_FAILED",
        details: upsertResult,
      });
      continue;
    }

    synced.push({
      internalServiceKey,
      internalServiceName,
      externalServiceId: match.candidate.externalServiceId,
      externalServiceVersion: match.candidate.externalServiceVersion,
      externalLocationId: match.candidate.externalLocationId,
      externalServiceName: match.candidate.externalServiceName,
      matchStatus: match.matchStatus,
      matchConfidence: match.matchConfidence,
    });
  }

  return {
    ok: true,
    synced,
    skipped,
    squareServicesCount: candidates.length,
  };
}