// src/modules/field-operations/services/appointmentFieldOperations.service.ts

import {
  deleteAppointmentLocation,
  getAppointmentLocation,
  saveAppointmentLocation,
} from "../repositories/appointmentLocations.repo";

import {
  deleteResourceAssignment,
  getResourceAssignment,
  listResourceAssignments,
  saveResourceAssignment,
  updateResourceAssignmentStatus,
} from "../repositories/resourceAssignments.repo";

import {
  getFieldOperationResourceById,
} from "../repositories/fieldResources.repo";

/**
 * Inferimos los inputs directamente desde los repositorios.
 *
 * Así evitamos duplicar contratos y mantener tipos paralelos que
 * podrían desincronizarse cuando cambien los repositorios.
 */
type SaveAppointmentLocationRepositoryInput =
  Parameters<typeof saveAppointmentLocation>[0];

type SaveResourceAssignmentRepositoryInput =
  Parameters<typeof saveResourceAssignment>[0];

export type SetAppointmentFieldLocationInput = Omit<
  SaveAppointmentLocationRepositoryInput,
  "tenantId" | "appointmentId"
> & {
  tenantId: string;
  appointmentId: string;
};

export type AssignAppointmentResourceInput = Omit<
  SaveResourceAssignmentRepositoryInput,
  "tenantId" | "appointmentId"
> & {
  tenantId: string;
  appointmentId: string;
};

export type GetAppointmentFieldOperationsInput = {
  tenantId: string;
  appointmentId: string;
};

export type RemoveAppointmentResourceInput = {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole?: string;
};

export type ChangeAppointmentResourceStatusInput = {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole?: string;
  assignmentStatus: string;
};

function requiredString(
  value: unknown,
  fieldName: string
): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(
      `FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`
    );
  }

  return normalized;
}

/**
 * Guarda o actualiza la ubicación operativa de un appointment.
 *
 * Este método no modifica la tabla appointments.
 * La ubicación queda únicamente en appointment_locations.
 */
export async function setAppointmentFieldLocation(
  input: SetAppointmentFieldLocationInput
) {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  return saveAppointmentLocation({
    ...input,
    tenantId,
    appointmentId,
  });
}

/**
 * Obtiene la ubicación operativa asociada a un appointment.
 */
export async function getAppointmentFieldLocation(input: {
  tenantId: string;
  appointmentId: string;
}) {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  return getAppointmentLocation({
    tenantId,
    appointmentId,
  });
}

/**
 * Elimina solamente la ubicación del módulo Field Operations.
 *
 * No elimina ni cancela el appointment original.
 */
export async function removeAppointmentFieldLocation(input: {
  tenantId: string;
  appointmentId: string;
}): Promise<boolean> {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  return deleteAppointmentLocation({
    tenantId,
    appointmentId,
  });
}

/**
 * Asigna un recurso operativo a un appointment.
 *
 * Antes de crear la asignación:
 * 1. Verifica que el recurso pertenezca al tenant.
 * 2. Verifica que el recurso exista.
 * 3. Verifica que esté activo.
 *
 * No modifica staff_id, provider, Square, Google Calendar,
 * disponibilidad ni ninguna parte del booking actual.
 */
export async function assignResourceToAppointment(
  input: AssignAppointmentResourceInput
) {
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

  const resource = await getFieldOperationResourceById({
    tenantId,
    resourceId,
  });

  if (!resource) {
    throw new Error(
      "FIELD_OPERATIONS_RESOURCE_NOT_FOUND"
    );
  }

  if (!resource.active) {
    throw new Error(
      "FIELD_OPERATIONS_RESOURCE_INACTIVE"
    );
  }

  return saveResourceAssignment({
    ...input,
    tenantId,
    appointmentId,
    resourceId,
  });
}

/**
 * Obtiene una asignación específica.
 */
export async function getAppointmentResourceAssignment(input: {
  tenantId: string;
  appointmentId: string;
  resourceId: string;
  assignmentRole?: string;
}) {
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

  return getResourceAssignment({
    tenantId,
    appointmentId,
    resourceId,
    assignmentRole: input.assignmentRole,
  });
}

/**
 * Cambia el estado de una asignación existente.
 *
 * Ejemplos posibles:
 * - assigned
 * - confirmed
 * - dispatched
 * - en_route
 * - arrived
 * - completed
 * - cancelled
 *
 * El servicio no impone una lista cerrada porque diferentes
 * industrias pueden necesitar estados distintos.
 */
export async function changeAppointmentResourceStatus(
  input: ChangeAppointmentResourceStatusInput
) {
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

  const assignmentStatus = requiredString(
    input.assignmentStatus,
    "assignmentStatus"
  );

  const assignment =
    await updateResourceAssignmentStatus({
      tenantId,
      appointmentId,
      resourceId,
      assignmentRole: input.assignmentRole,
      assignmentStatus,
    });

  if (!assignment) {
    throw new Error(
      "FIELD_OPERATIONS_ASSIGNMENT_NOT_FOUND"
    );
  }

  return assignment;
}

/**
 * Elimina una asignación del módulo Field Operations.
 *
 * No elimina:
 * - el appointment
 * - el recurso
 * - el staff original del booking
 * - la reserva en Square
 * - el evento de Google Calendar
 */
export async function removeResourceFromAppointment(
  input: RemoveAppointmentResourceInput
): Promise<boolean> {
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

  return deleteResourceAssignment({
    tenantId,
    appointmentId,
    resourceId,
    assignmentRole: input.assignmentRole,
  });
}

/**
 * Devuelve toda la información de Field Operations relacionada
 * con un appointment:
 *
 * - ubicación
 * - asignaciones
 * - recursos vinculados
 *
 * Si alguno de los recursos fue eliminado o dejó de estar
 * disponible, la asignación se conserva y resource será null.
 */
export async function getAppointmentFieldOperations(
  input: GetAppointmentFieldOperationsInput
) {
  const tenantId = requiredString(
    input.tenantId,
    "tenantId"
  );

  const appointmentId = requiredString(
    input.appointmentId,
    "appointmentId"
  );

  const [location, assignments] = await Promise.all([
    getAppointmentLocation({
      tenantId,
      appointmentId,
    }),

    listResourceAssignments({
      tenantId,
      appointmentId,
    }),
  ]);

  const assignmentsWithResources = await Promise.all(
    assignments.map(async (assignment) => {
      const resource =
        await getFieldOperationResourceById({
          tenantId,
          resourceId: assignment.resourceId,
        });

      return {
        assignment,
        resource,
      };
    })
  );

  return {
    tenantId,
    appointmentId,
    location,
    assignments: assignmentsWithResources,
  };
}