import pool from "../../db";

export type SaveTenantExternalServiceMappingArgs = {
  tenantId: string;
  provider: "square";
  internalServiceKey: string;
  externalServiceId: string;
  externalServiceVersion?: number | null;
  externalLocationId?: string | null;
  externalMetadata?: Record<string, unknown> | null;
  isActive?: boolean;
};

export type SavedTenantExternalServiceMapping = {
  id: string;
  tenantId: string;
  provider: "square";
  internalServiceKey: string;
  externalServiceId: string;
  externalServiceVersion: number | null;
  externalLocationId: string | null;
  externalMetadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SaveTenantExternalServiceMappingResult =
  | {
      ok: true;
      mapping: SavedTenantExternalServiceMapping;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      details?: unknown;
    };

export async function saveTenantExternalServiceMapping(
  args: SaveTenantExternalServiceMappingArgs
): Promise<SaveTenantExternalServiceMappingResult> {
  const tenantId = String(args.tenantId || "").trim();
  const provider = args.provider;
  const internalServiceKey = String(args.internalServiceKey || "").trim();
  const externalServiceId = String(args.externalServiceId || "").trim();
  const externalServiceVersion =
    args.externalServiceVersion == null
      ? null
      : Number(args.externalServiceVersion);
  const externalLocationId = String(args.externalLocationId || "").trim() || null;
  const externalMetadata =
    args.externalMetadata && typeof args.externalMetadata === "object"
      ? args.externalMetadata
      : {};
  const isActive = args.isActive !== false;

  if (!tenantId || !provider || !internalServiceKey || !externalServiceId) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  if (
    externalServiceVersion != null &&
    !Number.isFinite(externalServiceVersion)
  ) {
    return {
      ok: false,
      error: "INVALID_EXTERNAL_SERVICE_VERSION",
      status: 400,
    };
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO tenant_external_service_mappings (
        tenant_id,
        provider,
        internal_service_key,
        external_service_id,
        external_service_version,
        external_location_id,
        external_metadata,
        is_active,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
      ON CONFLICT (tenant_id, provider, internal_service_key)
      DO UPDATE SET
        external_service_id = EXCLUDED.external_service_id,
        external_service_version = EXCLUDED.external_service_version,
        external_location_id = EXCLUDED.external_location_id,
        external_metadata = EXCLUDED.external_metadata,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING
        id,
        tenant_id,
        provider,
        internal_service_key,
        external_service_id,
        external_service_version,
        external_location_id,
        external_metadata,
        is_active,
        created_at,
        updated_at
      `,
      [
        tenantId,
        provider,
        internalServiceKey,
        externalServiceId,
        externalServiceVersion,
        externalLocationId,
        JSON.stringify(externalMetadata),
        isActive,
      ]
    );

    const row = result.rows[0];

    return {
      ok: true,
      mapping: {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        provider: row.provider,
        internalServiceKey: String(row.internal_service_key),
        externalServiceId: String(row.external_service_id),
        externalServiceVersion:
          row.external_service_version == null
            ? null
            : Number(row.external_service_version),
        externalLocationId: row.external_location_id
          ? String(row.external_location_id)
          : null,
        externalMetadata:
          row.external_metadata && typeof row.external_metadata === "object"
            ? row.external_metadata
            : {},
        isActive: Boolean(row.is_active),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      },
    };
  } catch (error) {
    console.error("[saveTenantExternalServiceMapping] unexpected error", error);
    return {
      ok: false,
      error: "SAVE_TENANT_EXTERNAL_SERVICE_MAPPING_FAILED",
      status: 500,
      details: error instanceof Error ? error.message : error,
    };
  }
}