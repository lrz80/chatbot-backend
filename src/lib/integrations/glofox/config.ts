// src/lib/integrations/glofox/config.ts

import {
  getBookingProviderConnection,
  getBookingProviderCredentials,
} from "../../appointments/booking/providers/providerConnections.repo";

import type { GlofoxEnvironment } from "./types";
import { GlofoxApiError } from "./types";

export type ResolvedGlofoxConfig = {
  tenantId: string;
  branchId: string;
  apiKey: string;
  apiToken: string;
  environment: GlofoxEnvironment;
};

const SUPPORTED_ENVIRONMENTS: ReadonlySet<GlofoxEnvironment> =
  new Set<GlofoxEnvironment>([
    "development",
    "testing",
    "staging",
    "sandbox",
    "production",
  ]);

function cleanString(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function resolveEnvironment(
  metadata: Record<string, unknown>
): GlofoxEnvironment {
  const rawEnvironment = cleanString(
    metadata.environment
  ).toLowerCase();

  if (!rawEnvironment) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      "Glofox environment is not configured."
    );
  }

  if (
    !SUPPORTED_ENVIRONMENTS.has(
      rawEnvironment as GlofoxEnvironment
    )
  ) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      `Unsupported Glofox environment: ${rawEnvironment}`
    );
  }

  return rawEnvironment as GlofoxEnvironment;
}

export async function getGlofoxConfigForTenant(
  tenantId: string
): Promise<ResolvedGlofoxConfig> {
  const normalizedTenantId = cleanString(tenantId);

  if (!normalizedTenantId) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      "Tenant ID is required."
    );
  }

  const connection =
    await getBookingProviderConnection(
      normalizedTenantId,
      "glofox"
    );

  if (!connection) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      "Glofox is not configured for this tenant."
    );
  }

  if (connection.status !== "active") {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      `Glofox connection is not active. Current status: ${connection.status}`
    );
  }

  const branchId = cleanString(
    connection.external_location_id
  );

  if (!branchId) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      "Glofox branch ID is not configured."
    );
  }

  const credentials =
    await getBookingProviderCredentials(
      normalizedTenantId,
      "glofox"
    );

  if (!credentials) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      "Glofox credentials are not configured."
    );
  }

  const apiKey = cleanString(
    credentials.apiKey
  );

  const apiToken = cleanString(
    credentials.apiToken
  );

  if (!apiKey) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      "Glofox API key is not configured."
    );
  }

  if (!apiToken) {
    throw new GlofoxApiError(
      "GLOFOX_INVALID_CONFIG",
      "Glofox API token is not configured."
    );
  }

  const environment = resolveEnvironment(
    connection.metadata
  );

  return {
    tenantId: normalizedTenantId,
    branchId,
    apiKey,
    apiToken,
    environment,
  };
}