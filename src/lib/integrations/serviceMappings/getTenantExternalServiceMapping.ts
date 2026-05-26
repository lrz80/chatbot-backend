//src/lib/integrations/serviceMappings/getTenantExternalServiceMapping.ts
import pool from "../../db";

export type GetTenantExternalServiceMappingInput = {
  tenantId: string;
  provider: string;
  internalServiceKey: string;
};

export type UpsertTenantExternalServiceMappingInput = {
  tenantId: string;
  provider: string;
  internalServiceKey: string;
  externalServiceId: string;
  externalServiceVersion?: number | null;
  externalLocationId?: string | null;
  externalMetadata?: Record<string, unknown>;
  isActive?: boolean;
};

export type TenantExternalServiceMapping = {
  id: string;
  tenantId: string;
  provider: string;
  internalServiceKey: string;
  externalServiceId: string;
  externalServiceVersion: number | null;
  externalLocationId: string | null;
  externalMetadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GetTenantExternalServiceMappingResult =
  | {
      ok: true;
      mapping: TenantExternalServiceMapping;
    }
  | {
      ok: false;
      error: string;
      status: number;
      details?: unknown;
    };

function normalizeMappingKey(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(String(value || "").trim());

  return Number.isFinite(parsed) ? parsed : null;
}

function mapRow(row: any): TenantExternalServiceMapping {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    provider: String(row.provider),
    internalServiceKey: String(row.internal_service_key),
    externalServiceId: String(row.external_service_id),
    externalServiceVersion:
      row.external_service_version == null
        ? null
        : Number(row.external_service_version),
    externalLocationId: row.external_location_id
      ? String(row.external_location_id)
      : null,
    externalMetadata: normalizeMetadata(row.external_metadata),
    isActive: Boolean(row.is_active),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getTenantExternalServiceMapping(
  input: GetTenantExternalServiceMappingInput
): Promise<GetTenantExternalServiceMappingResult> {
  const tenantId = String(input.tenantId || "").trim();
  const provider = String(input.provider || "").trim();
  const internalServiceKey = String(input.internalServiceKey || "").trim();

  if (!tenantId || !provider || !internalServiceKey) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
    };
  }

  const exactResult = await pool.query(
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

  if (exactResult.rows[0]) {
    return {
      ok: true,
      mapping: mapRow(exactResult.rows[0]),
    };
  }

  const normalizedInputKey = normalizeMappingKey(internalServiceKey);

  const fallbackResult = await pool.query(
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
      AND is_active = true
    `,
    [tenantId, provider]
  );

  const matchedRow = fallbackResult.rows.find((row: any) => {
    return normalizeMappingKey(row.internal_service_key) === normalizedInputKey;
  });

  if (!matchedRow) {
    return {
      ok: false,
      error: "TENANT_EXTERNAL_SERVICE_MAPPING_NOT_FOUND",
      status: 404,
      details: {
        tenantId,
        provider,
        internalServiceKey,
        normalizedInputKey,
        availableKeys: fallbackResult.rows.map((row: any) => ({
          internalServiceKey: String(row.internal_service_key || ""),
          normalizedKey: normalizeMappingKey(row.internal_service_key),
        })),
      },
    };
  }

  return {
    ok: true,
    mapping: mapRow(matchedRow),
  };
}

export async function upsertTenantExternalServiceMapping(
  input: UpsertTenantExternalServiceMappingInput
): Promise<GetTenantExternalServiceMappingResult> {
  const tenantId = String(input.tenantId || "").trim();
  const provider = String(input.provider || "").trim();
  const internalServiceKey = String(input.internalServiceKey || "").trim();
  const externalServiceId = String(input.externalServiceId || "").trim();
  const externalServiceVersion =
    input.externalServiceVersion == null
      ? null
      : normalizeNumber(input.externalServiceVersion);
  const externalLocationId =
    String(input.externalLocationId || "").trim() || null;
  const externalMetadata = normalizeMetadata(input.externalMetadata);
  const isActive =
    typeof input.isActive === "boolean" ? input.isActive : true;

  if (!tenantId || !provider || !internalServiceKey || !externalServiceId) {
    return {
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      status: 400,
      details: {
        tenantId: Boolean(tenantId),
        provider: Boolean(provider),
        internalServiceKey: Boolean(internalServiceKey),
        externalServiceId: Boolean(externalServiceId),
      },
    };
  }

  const existingResult = await getTenantExternalServiceMapping({
    tenantId,
    provider,
    internalServiceKey,
  });

  if (existingResult.ok) {
    const { rows } = await pool.query(
      `
      UPDATE tenant_external_service_mappings
      SET
        internal_service_key = $4,
        external_service_id = $5,
        external_service_version = $6,
        external_location_id = $7,
        external_metadata = $8::jsonb,
        is_active = $9,
        updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
        AND provider = $3
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
        existingResult.mapping.id,
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

    return {
      ok: true,
      mapping: mapRow(rows[0]),
    };
  }

  const { rows } = await pool.query(
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
      created_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW()
    )
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

  return {
    ok: true,
    mapping: mapRow(rows[0]),
  };
}