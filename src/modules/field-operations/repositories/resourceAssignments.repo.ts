// src/modules/field-operations/repositories/resourceAssignments.repo.ts

import { randomUUID } from "node:crypto";
import pool from "../../../lib/db";

export type ResourceAssignment = {
  id: string;
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole: string;
  assignmentStatus: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ResourceAssignmentRow = {
  id: string;
  tenant_id: string;
  appointment_id: string;
  resource_id: string;
  assignment_role: string;
  assignment_status: string;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SaveResourceAssignmentInput = {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole?: string;
  assignmentStatus?: string;
  metadata?: Record<string, unknown>;
};

function requiredString(value: unknown, fieldName: string): string {
  const result = String(value ?? "").trim();

  if (!result) {
    throw new Error(`FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`);
  }

  return result;
}

function optionalString(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result || null;
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

function mapAssignmentRow(
  row: ResourceAssignmentRow
): ResourceAssignment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    appointmentId: row.appointment_id,
    resourceId: row.resource_id,
    assignmentRole: row.assignment_role,
    assignmentStatus: row.assignment_status,
    metadata:
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? row.metadata
        : {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function saveResourceAssignment(
  input: SaveResourceAssignmentInput
): Promise<ResourceAssignment> {
  const id = randomUUID();

  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  const resourceId = requiredString(
    input.resourceId,
    "resourceId"
  );

  const assignmentRole =
    optionalString(input.assignmentRole) ?? "primary";

  const assignmentStatus =
    optionalString(input.assignmentStatus) ?? "assigned";

  const { rows } = await pool.query<ResourceAssignmentRow>(
    `
    INSERT INTO appointment_resource_assignments (
      id,
      tenant_id,
      appointment_id,
      resource_id,
      assignment_role,
      assignment_status,
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
      $7::jsonb,
      NOW(),
      NOW()
    )
    ON CONFLICT (
      tenant_id,
      appointment_id,
      assignment_role
    )
    DO UPDATE SET
      resource_id = EXCLUDED.resource_id,
      assignment_status = EXCLUDED.assignment_status,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
    `,
    [
      id,
      tenantId,
      appointmentId,
      resourceId,
      assignmentRole,
      assignmentStatus,
      JSON.stringify(input.metadata ?? {}),
    ]
  );

  const row = rows[0];

  if (!row) {
    throw new Error(
      "FIELD_OPERATIONS_ASSIGNMENT_SAVE_FAILED"
    );
  }

  return mapAssignmentRow(row);
}

export async function getResourceAssignment(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole?: string;
}): Promise<ResourceAssignment | null> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );
  const resourceId = requiredString(input.resourceId, "resourceId");

  const assignmentRole =
    optionalString(input.assignmentRole) ?? "primary";

  const { rows } = await pool.query<ResourceAssignmentRow>(
    `
    SELECT *
    FROM appointment_resource_assignments
    WHERE tenant_id = $1
      AND appointment_id = $2
      AND resource_id = $3
      AND assignment_role = $4
    LIMIT 1
    `,
    [tenantId, appointmentId, resourceId, assignmentRole]
  );

  return rows[0] ? mapAssignmentRow(rows[0]) : null;
}

export async function listResourceAssignments(input: {
  tenantId: string;
  resourceId?: string;
  appointmentId?: string;
  assignmentStatus?: string;
}): Promise<ResourceAssignment[]> {
  const tenantId = requiredString(input.tenantId, "tenantId");

  const values: unknown[] = [tenantId];
  const conditions = ["tenant_id = $1"];

  const resourceId = optionalString(input.resourceId);
  const appointmentId = optionalString(input.appointmentId);
  const assignmentStatus = optionalString(input.assignmentStatus);

  if (resourceId) {
    values.push(resourceId);
    conditions.push(`resource_id = $${values.length}`);
  }

  if (appointmentId) {
    values.push(appointmentId);
    conditions.push(`appointment_id = $${values.length}`);
  }

  if (assignmentStatus) {
    values.push(assignmentStatus);
    conditions.push(`assignment_status = $${values.length}`);
  }

  const { rows } = await pool.query<ResourceAssignmentRow>(
    `
    SELECT *
    FROM appointment_resource_assignments
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY created_at ASC
    `,
    values
  );

  return rows.map(mapAssignmentRow);
}

export async function updateResourceAssignmentStatus(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole?: string;
  assignmentStatus: string;
}): Promise<ResourceAssignment | null> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );
  const resourceId = requiredString(input.resourceId, "resourceId");

  const assignmentRole =
    optionalString(input.assignmentRole) ?? "primary";

  const assignmentStatus = requiredString(
    input.assignmentStatus,
    "assignmentStatus"
  );

  const { rows } = await pool.query<ResourceAssignmentRow>(
    `
    UPDATE appointment_resource_assignments
    SET assignment_status = $5,
        updated_at = NOW()
    WHERE tenant_id = $1
      AND appointment_id = $2
      AND resource_id = $3
      AND assignment_role = $4
    RETURNING *
    `,
    [
      tenantId,
      appointmentId,
      resourceId,
      assignmentRole,
      assignmentStatus,
    ]
  );

  return rows[0] ? mapAssignmentRow(rows[0]) : null;
}

export async function deleteResourceAssignment(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole?: string;
}): Promise<boolean> {
  const tenantId = requiredString(input.tenantId, "tenantId");
  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );
  const resourceId = requiredString(input.resourceId, "resourceId");

  const assignmentRole =
    optionalString(input.assignmentRole) ?? "primary";

  const result = await pool.query(
    `
    DELETE FROM appointment_resource_assignments
    WHERE tenant_id = $1
      AND appointment_id = $2
      AND resource_id = $3
      AND assignment_role = $4
    `,
    [tenantId, appointmentId, resourceId, assignmentRole]
  );

  return (result.rowCount ?? 0) > 0;
}