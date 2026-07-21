BEGIN;

-- Conserva una sola asignación por rol para cada cita.
-- Prioriza asignaciones activas y luego la actualización más reciente.
WITH ranked_assignments AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        tenant_id,
        appointment_id,
        assignment_role
      ORDER BY
        CASE
          WHEN assignment_status IN (
            'assigned',
            'accepted',
            'confirmed',
            'dispatched',
            'en_route',
            'arrived',
            'in_progress'
          )
          THEN 0
          ELSE 1
        END,
        updated_at DESC,
        created_at DESC,
        id DESC
    ) AS row_number
  FROM appointment_resource_assignments
)
DELETE FROM appointment_resource_assignments ara
USING ranked_assignments ranked
WHERE ara.id = ranked.id
  AND ranked.row_number > 1;

-- Una cita solo puede tener un recurso por assignment_role.
CREATE UNIQUE INDEX IF NOT EXISTS
  uq_appointment_resource_assignments_role
ON appointment_resource_assignments (
  tenant_id,
  appointment_id,
  assignment_role
);

COMMIT;