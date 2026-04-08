import pool from "../../db";

export type TenantExternalServiceMapping = {
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

export type GetTenantExternalServiceMappingArgs = {
  tenantId: string;
  provider: "square";
  internalServiceKey: string;
};

export type GetTenantExternalServiceMappingResult =
  | {
      ok: true;
      mapping: TenantExternalServiceMapping;
    }
  | {
      ok: false;
      error: string;
      status?: number;
    };

export async function getTenantExternalServiceMapping(
  args: GetTenantExternalServiceMappingArgs
): Promise<GetTenantExternalServiceMappingResult> {
  const tenantId = String(args.tenantId || "").trim();
  const provider = args.provider;
  const internalServiceKey = String(args.internalServiceKey || "").trim();

  if (!tenantId || !provider || !internalServiceKey) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  const result = await pool.query(
    `
    SELECT
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
    FROM tenant_external_service_mappings
    WHERE tenant_id = $1
      AND provider = $2
      AND internal_service_key = $3
      AND is_active = true
    LIMIT 1
    `,
    [tenantId, provider, internalServiceKey]
  );

  const row = result.rows[0];

  if (!row) {
    return {
      ok: false,
      error: "TENANT_EXTERNAL_SERVICE_MAPPING_NOT_FOUND",
      status: 404,
    };
  }

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
}