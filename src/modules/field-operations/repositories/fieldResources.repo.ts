// src/modules/field-operations/repositories/fieldResources.repo.ts

import { randomUUID } from "node:crypto";
import pool from "../../../lib/db";
import type {
  FieldOperationResource,
  FieldOperationResourceType,
} from "../domain/fieldOperations.types";

type DatabaseJson = Record<string, unknown> | unknown[];

type FieldOperationResourceRow = {
  id: string;
  tenant_id: string;

  name: string;
  resource_type: FieldOperationResourceType;

  external_provider: string | null;
  external_reference: string | null;

  active: boolean;

  start_address: string | null;
  start_latitude: number | string | null;
  start_longitude: number | string | null;

  end_address: string | null;
  end_latitude: number | string | null;
  end_longitude: number | string | null;

  timezone: string | null;

  availability: DatabaseJson | null;
  capabilities: DatabaseJson | null;
  metadata: DatabaseJson | null;

  created_at: Date | string;
  updated_at: Date | string;
};

export type CreateFieldOperationResourceInput = {
  tenantId: string;

  name: string;
  resourceType: FieldOperationResourceType;

  externalProvider?: string | null;
  externalReference?: string | null;

  active?: boolean;

  startAddress?: string | null;
  startLatitude?: number | null;
  startLongitude?: number | null;

  endAddress?: string | null;
  endLatitude?: number | null;
  endLongitude?: number | null;

  timezone?: string | null;

  availability?: Record<string, unknown>;
  capabilities?: unknown[];
  metadata?: Record<string, unknown>;
};

export type UpdateFieldOperationResourceInput = {
  name?: string;
  resourceType?: FieldOperationResourceType;

  externalProvider?: string | null;
  externalReference?: string | null;

  active?: boolean;

  startAddress?: string | null;
  startLatitude?: number | null;
  startLongitude?: number | null;

  endAddress?: string | null;
  endLatitude?: number | null;
  endLongitude?: number | null;

  timezone?: string | null;

  availability?: Record<string, unknown>;
  capabilities?: unknown[];
  metadata?: Record<string, unknown>;
};

function cleanRequiredString(value: unknown, fieldName: string): string {
  const result = String(value ?? "").trim();

  if (!result) {
    throw new Error(`FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`);
  }

  return result;
}

function cleanOptionalString(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
}

function normalizeCoordinate(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);

  if (
    !Number.isFinite(numberValue) ||
    numberValue < minimum ||
    numberValue > maximum
  ) {
    throw new Error(`FIELD_OPERATIONS_INVALID_COORDINATE:${fieldName}`);
  }

  return numberValue;
}

function parseNumberOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseObjectJson(value: DatabaseJson | null): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function parseArrayJson(value: DatabaseJson | null): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("FIELD_OPERATIONS_INVALID_DATABASE_TIMESTAMP");
  }

  return parsed.toISOString();
}

function mapResourceRow(
  row: FieldOperationResourceRow
): FieldOperationResource {
  return {
    id: row.id,
    tenantId: row.tenant_id,

    name: row.name,
    resourceType: row.resource_type,

    externalProvider: row.external_provider,
    externalReference: row.external_reference,

    active: row.active,

    startAddress: row.start_address,
    startLatitude: parseNumberOrNull(row.start_latitude),
    startLongitude: parseNumberOrNull(row.start_longitude),

    endAddress: row.end_address,
    endLatitude: parseNumberOrNull(row.end_latitude),
    endLongitude: parseNumberOrNull(row.end_longitude),

    timezone: row.timezone,

    availability: parseObjectJson(row.availability),
    capabilities: parseArrayJson(row.capabilities),
    metadata: parseObjectJson(row.metadata),

    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function createFieldOperationResource(
  input: CreateFieldOperationResourceInput
): Promise<FieldOperationResource> {
  const id = randomUUID();
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");
  const name = cleanRequiredString(input.name, "name");

  const resourceType = cleanRequiredString(
    input.resourceType,
    "resourceType"
  ) as FieldOperationResourceType;

  const startLatitude = normalizeCoordinate(
    input.startLatitude,
    "startLatitude",
    -90,
    90
  );

  const startLongitude = normalizeCoordinate(
    input.startLongitude,
    "startLongitude",
    -180,
    180
  );

  const endLatitude = normalizeCoordinate(
    input.endLatitude,
    "endLatitude",
    -90,
    90
  );

  const endLongitude = normalizeCoordinate(
    input.endLongitude,
    "endLongitude",
    -180,
    180
  );

  const { rows } = await pool.query<FieldOperationResourceRow>(
    `
    INSERT INTO field_operation_resources (
      id,
      tenant_id,
      name,
      resource_type,
      external_provider,
      external_reference,
      active,
      start_address,
      start_latitude,
      start_longitude,
      end_address,
      end_latitude,
      end_longitude,
      timezone,
      availability,
      capabilities,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15::jsonb,
      $16::jsonb,
      $17::jsonb,
      NOW(),
      NOW()
    )
    RETURNING *
    `,
    [
      id,
      tenantId,
      name,
      resourceType,
      cleanOptionalString(input.externalProvider),
      cleanOptionalString(input.externalReference),
      input.active ?? true,
      cleanOptionalString(input.startAddress),
      startLatitude,
      startLongitude,
      cleanOptionalString(input.endAddress),
      endLatitude,
      endLongitude,
      cleanOptionalString(input.timezone),
      JSON.stringify(input.availability ?? {}),
      JSON.stringify(input.capabilities ?? []),
      JSON.stringify(input.metadata ?? {}),
    ]
  );

  const row = rows[0];

  if (!row) {
    throw new Error("FIELD_OPERATIONS_RESOURCE_CREATE_FAILED");
  }

  return mapResourceRow(row);
}

export async function getFieldOperationResourceById(input: {
  tenantId: string;
  resourceId: string;
}): Promise<FieldOperationResource | null> {
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");
  const resourceId = cleanRequiredString(input.resourceId, "resourceId");

  const { rows } = await pool.query<FieldOperationResourceRow>(
    `
    SELECT *
    FROM field_operation_resources
    WHERE tenant_id = $1
      AND id = $2
    LIMIT 1
    `,
    [tenantId, resourceId]
  );

  return rows[0] ? mapResourceRow(rows[0]) : null;
}

export async function listFieldOperationResources(input: {
  tenantId: string;
  active?: boolean;
}): Promise<FieldOperationResource[]> {
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");

  const values: unknown[] = [tenantId];
  const conditions = ["tenant_id = $1"];

  if (typeof input.active === "boolean") {
    values.push(input.active);
    conditions.push(`active = $${values.length}`);
  }

  const { rows } = await pool.query<FieldOperationResourceRow>(
    `
    SELECT *
    FROM field_operation_resources
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY active DESC, name ASC, created_at ASC
    `,
    values
  );

  return rows.map(mapResourceRow);
}

export async function updateFieldOperationResource(
  tenantIdInput: string,
  resourceIdInput: string,
  input: UpdateFieldOperationResourceInput
): Promise<FieldOperationResource | null> {
  const tenantId = cleanRequiredString(tenantIdInput, "tenantId");
  const resourceId = cleanRequiredString(resourceIdInput, "resourceId");

  const assignments: string[] = [];
  const values: unknown[] = [tenantId, resourceId];

  function addAssignment(column: string, value: unknown): void {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (input.name !== undefined) {
    addAssignment("name", cleanRequiredString(input.name, "name"));
  }

  if (input.resourceType !== undefined) {
    addAssignment(
      "resource_type",
      cleanRequiredString(input.resourceType, "resourceType")
    );
  }

  if (input.externalProvider !== undefined) {
    addAssignment(
      "external_provider",
      cleanOptionalString(input.externalProvider)
    );
  }

  if (input.externalReference !== undefined) {
    addAssignment(
      "external_reference",
      cleanOptionalString(input.externalReference)
    );
  }

  if (input.active !== undefined) {
    addAssignment("active", input.active);
  }

  if (input.startAddress !== undefined) {
    addAssignment("start_address", cleanOptionalString(input.startAddress));
  }

  if (input.startLatitude !== undefined) {
    addAssignment(
      "start_latitude",
      normalizeCoordinate(input.startLatitude, "startLatitude", -90, 90)
    );
  }

  if (input.startLongitude !== undefined) {
    addAssignment(
      "start_longitude",
      normalizeCoordinate(input.startLongitude, "startLongitude", -180, 180)
    );
  }

  if (input.endAddress !== undefined) {
    addAssignment("end_address", cleanOptionalString(input.endAddress));
  }

  if (input.endLatitude !== undefined) {
    addAssignment(
      "end_latitude",
      normalizeCoordinate(input.endLatitude, "endLatitude", -90, 90)
    );
  }

  if (input.endLongitude !== undefined) {
    addAssignment(
      "end_longitude",
      normalizeCoordinate(input.endLongitude, "endLongitude", -180, 180)
    );
  }

  if (input.timezone !== undefined) {
    addAssignment("timezone", cleanOptionalString(input.timezone));
  }

  if (input.availability !== undefined) {
    values.push(JSON.stringify(input.availability));
    assignments.push(`availability = $${values.length}::jsonb`);
  }

  if (input.capabilities !== undefined) {
    values.push(JSON.stringify(input.capabilities));
    assignments.push(`capabilities = $${values.length}::jsonb`);
  }

  if (input.metadata !== undefined) {
    values.push(JSON.stringify(input.metadata));
    assignments.push(`metadata = $${values.length}::jsonb`);
  }

  if (assignments.length === 0) {
    return getFieldOperationResourceById({
      tenantId,
      resourceId,
    });
  }

  assignments.push("updated_at = NOW()");

  const { rows } = await pool.query<FieldOperationResourceRow>(
    `
    UPDATE field_operation_resources
    SET ${assignments.join(",\n        ")}
    WHERE tenant_id = $1
      AND id = $2
    RETURNING *
    `,
    values
  );

  return rows[0] ? mapResourceRow(rows[0]) : null;
}

export async function deactivateFieldOperationResource(input: {
  tenantId: string;
  resourceId: string;
}): Promise<boolean> {
  const tenantId = cleanRequiredString(input.tenantId, "tenantId");
  const resourceId = cleanRequiredString(input.resourceId, "resourceId");

  const result = await pool.query(
    `
    UPDATE field_operation_resources
    SET active = FALSE,
        updated_at = NOW()
    WHERE tenant_id = $1
      AND id = $2
      AND active = TRUE
    `,
    [tenantId, resourceId]
  );

  return (result.rowCount ?? 0) > 0;
}