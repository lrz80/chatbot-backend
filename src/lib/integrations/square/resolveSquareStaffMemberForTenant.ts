//src/lib/integrations/square/resolveSquareStaffMemberForTenant.ts
import {
  getBookingProviderConnection,
  getBookingProviderSecrets,
} from "../../appointments/booking/providers/providerConnections.repo";
import {
  squareListTeamMemberBookingProfiles,
  type SquareEnvironment,
  type SquareTeamMemberBookingProfile,
} from "../../appointments/booking/providers/square.client";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeComparable(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSquareEnvironment(value: unknown): SquareEnvironment {
  return value === "sandbox" ? "sandbox" : "production";
}

function tokenize(value: unknown): string[] {
  return normalizeComparable(value).split(" ").filter(Boolean);
}

function computeStaffMatchScore(params: {
  input: string;
  displayName: string;
}): number {
  const input = normalizeComparable(params.input);
  const displayName = normalizeComparable(params.displayName);

  if (!input || !displayName) return 0;
  if (input === displayName) return 1;

  const inputTokens = new Set(tokenize(input));
  const nameTokens = new Set(tokenize(displayName));

  if (inputTokens.size === 0 || nameTokens.size === 0) return 0;

  let overlap = 0;

  for (const token of inputTokens) {
    if (nameTokens.has(token)) {
      overlap += 1;
    }
  }

  const coverageInput = overlap / inputTokens.size;
  const coverageName = overlap / nameTokens.size;

  return Math.max(coverageInput, coverageName);
}

function resolveConfiguredAnyOption(params: {
  inputText: string;
  validationConfig?: Record<string, unknown> | null;
  locale?: string;
}): boolean {
  const input = normalizeComparable(params.inputText);
  const config = params.validationConfig || {};

  const anyOptionValue = normalizeComparable(config.any_option_value);

  if (anyOptionValue && input === anyOptionValue) {
    return true;
  }

  const labelsRaw = config.any_option_labels;
  const labels: string[] = [];

  if (Array.isArray(labelsRaw)) {
    for (const item of labelsRaw) {
      const label = clean(item);
      if (label) labels.push(label);
    }
  }

  if (
    labelsRaw &&
    typeof labelsRaw === "object" &&
    !Array.isArray(labelsRaw)
  ) {
    const labelsByLocale = labelsRaw as Record<string, unknown>;
    const localeLabels = labelsByLocale[clean(params.locale)] || labelsByLocale.default;

    if (Array.isArray(localeLabels)) {
      for (const item of localeLabels) {
        const label = clean(item);
        if (label) labels.push(label);
      }
    }
  }

  return labels.some((label) => normalizeComparable(label) === input);
}

export type ResolveSquareStaffMemberForTenantResult =
  | {
      ok: true;
      preference: "any";
      teamMemberId: null;
      displayName: null;
      candidates: [];
    }
  | {
      ok: true;
      preference: "specific";
      teamMemberId: string;
      displayName: string;
      candidates: Array<{
        teamMemberId: string;
        displayName: string;
        score: number;
      }>;
    }
  | {
      ok: false;
      error:
        | "SQUARE_PROVIDER_NOT_CONFIGURED"
        | "SQUARE_ACCESS_TOKEN_MISSING"
        | "SQUARE_TEAM_MEMBERS_FETCH_FAILED"
        | "SQUARE_STAFF_NOT_FOUND"
        | "SQUARE_STAFF_AMBIGUOUS";
      status?: number;
      candidates?: Array<{
        teamMemberId: string;
        displayName: string;
        score: number;
      }>;
      details?: unknown;
    };

export async function resolveSquareStaffMemberForTenant(params: {
  tenantId: string;
  inputText: string;
  validationConfig?: Record<string, unknown> | null;
  locale?: string;
}): Promise<ResolveSquareStaffMemberForTenantResult> {
  const tenantId = clean(params.tenantId);
  const inputText = clean(params.inputText);

  if (
    resolveConfiguredAnyOption({
      inputText,
      validationConfig: params.validationConfig,
      locale: params.locale,
    })
  ) {
    return {
      ok: true,
      preference: "any",
      teamMemberId: null,
      displayName: null,
      candidates: [],
    };
  }

  const connection = await getBookingProviderConnection(tenantId, "square");

  if (!connection || connection.status !== "active") {
    return {
      ok: false,
      error: "SQUARE_PROVIDER_NOT_CONFIGURED",
    };
  }

  const secrets = await getBookingProviderSecrets(tenantId, "square");
  const accessToken = clean(secrets?.accessToken);

  if (!accessToken) {
    return {
      ok: false,
      error: "SQUARE_ACCESS_TOKEN_MISSING",
    };
  }

  const environment = resolveSquareEnvironment(connection.metadata?.environment);

  const staffResult = await squareListTeamMemberBookingProfiles({
    accessToken,
    environment,
  });

  if (!staffResult.ok) {
    return {
      ok: false,
      error: "SQUARE_TEAM_MEMBERS_FETCH_FAILED",
      status: staffResult.status,
      details: staffResult.details,
    };
  }

  const profiles = Array.isArray(staffResult.data.team_member_booking_profiles)
    ? staffResult.data.team_member_booking_profiles
    : [];

  const bookableProfiles = profiles.filter((profile: SquareTeamMemberBookingProfile) => {
    return profile.is_bookable === true && clean(profile.team_member_id) && clean(profile.display_name);
  });

  const candidates = bookableProfiles
    .map((profile) => {
      return {
        teamMemberId: clean(profile.team_member_id),
        displayName: clean(profile.display_name),
        score: computeStaffMatchScore({
          input: inputText,
          displayName: profile.display_name || "",
        }),
      };
    })
    .filter((candidate) => candidate.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return {
      ok: false,
      error: "SQUARE_STAFF_NOT_FOUND",
      candidates: [],
    };
  }

  const best = candidates[0];
  const second = candidates[1];

  if (second && best.score === second.score) {
    return {
      ok: false,
      error: "SQUARE_STAFF_AMBIGUOUS",
      candidates: candidates.slice(0, 5),
    };
  }

  return {
    ok: true,
    preference: "specific",
    teamMemberId: best.teamMemberId,
    displayName: best.displayName,
    candidates: candidates.slice(0, 5),
  };
}