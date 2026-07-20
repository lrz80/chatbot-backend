// src/modules/field-operations/routes/fieldOperations.routes.ts

import { Router, type Request, type Response } from "express";

import { authenticateUser } from "../../../middleware/auth";

import {
  createFieldOperationResource,
  deactivateFieldOperationResource,
  getFieldOperationResourceById,
  listFieldOperationResources,
  updateFieldOperationResource,
} from "../repositories/fieldResources.repo";

import {
  listAppointmentLocations,
  updateAppointmentLocationGeocoding,
} from "../repositories/appointmentLocations.repo";

import {
  listResourceAssignments,
} from "../repositories/resourceAssignments.repo";

import {
  getRoutePlanById,
  getRoutePlanByResourceAndDate,
  listRoutePlanStops,
  listRoutePlans,
  saveRoutePlan,
} from "../repositories/routePlans.repo";

import { optimizeRoutePlan } from "../services/routeOptimization.service";
import { buildRoutePlan } from "../services/routePlanBuilder.service";

import type { FieldOperationResourceType } from "../domain/fieldOperations.types";
import type { RoutingStopInput } from "../providers/routingProvider.types";

import {
  assignResourceToAppointment,
  changeAppointmentResourceStatus,
  getAppointmentFieldLocation,
  getAppointmentFieldOperations,
  getAppointmentResourceAssignment,
  removeAppointmentFieldLocation,
  removeResourceFromAppointment,
  setAppointmentFieldLocation,
} from "../services/appointmentFieldOperations.service";

const router = Router();

router.use(authenticateUser);

type AuthenticatedRequest = Request & {
  user?: {
    tenant_id?: string;
    tenantId?: string;
    id?: string;
    [key: string]: unknown;
  };
};

function requiredString(
  value: unknown,
  fieldName: string
): string {
  const result = String(value ?? "").trim();

  if (!result) {
    throw new Error(
      `FIELD_OPERATIONS_REQUIRED_FIELD:${fieldName}`
    );
  }

  return result;
}

function optionalString(
  value: unknown
): string | undefined {
  const result = String(value ?? "").trim();
  return result || undefined;
}

function optionalBoolean(
  value: unknown,
  fieldName: string
): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(
    `FIELD_OPERATIONS_INVALID_BOOLEAN:${fieldName}`
  );
}

function optionalNumber(
  value: unknown,
  fieldName: string
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_NUMBER:${fieldName}`
    );
  }

  return parsed;
}

function optionalObject(
  value: unknown,
  fieldName: string
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_OBJECT:${fieldName}`
    );
  }

  return value as Record<string, unknown>;
}

function optionalArray(
  value: unknown,
  fieldName: string
): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(
      `FIELD_OPERATIONS_INVALID_ARRAY:${fieldName}`
    );
  }

  return value;
}

function getTenantId(
  req: AuthenticatedRequest
): string {
  const tenantId =
    req.user?.tenant_id ??
    req.user?.tenantId;

  return requiredString(tenantId, "authenticatedTenantId");
}

function parseRoutingStops(
  value: unknown
): RoutingStopInput[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "FIELD_OPERATIONS_INVALID_ARRAY:stops"
    );
  }

  return value.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      throw new Error(
        `FIELD_OPERATIONS_INVALID_OBJECT:stops[${index}]`
      );
    }

    const stop = item as Record<string, unknown>;

    const appointmentId =
      stop.appointmentId === null ||
      stop.appointmentId === undefined
        ? null
        : requiredString(
            stop.appointmentId,
            `stops[${index}].appointmentId`
          );

    return {
      appointmentId,

      locationId: requiredString(
        stop.locationId,
        `stops[${index}].locationId`
      ),

      latitude: Number(stop.latitude),
      longitude: Number(stop.longitude),

      serviceDurationSeconds: Number(
        stop.serviceDurationSeconds
      ),

      scheduledStartAt:
        stop.scheduledStartAt === null ||
        stop.scheduledStartAt === undefined
          ? null
          : String(stop.scheduledStartAt),

      scheduledEndAt:
        stop.scheduledEndAt === null ||
        stop.scheduledEndAt === undefined
          ? null
          : String(stop.scheduledEndAt),

      isLocked:
        stop.isLocked === undefined
          ? false
          : Boolean(stop.isLocked),

      metadata: optionalObject(
        stop.metadata,
        `stops[${index}].metadata`
      ),
    };
  });
}

function errorStatus(error: Error): number {
  const message = error.message;

  if (
    message.includes("_NOT_FOUND") ||
    message.includes("NOT_FOUND")
  ) {
    return 404;
  }

  if (
    message.includes("DUPLICATE") ||
    message.includes("CONFLICT")
  ) {
    return 409;
  }

  if (
    message.includes("REQUIRED_FIELD") ||
    message.includes("INVALID_") ||
    message.includes("INACTIVE")
  ) {
    return 400;
  }

  return 500;
}

function handleError(
  res: Response,
  error: unknown
): Response {
  const normalizedError =
    error instanceof Error
      ? error
      : new Error(String(error));

  const status = errorStatus(normalizedError);

  console.error("[FIELD_OPERATIONS][API_ERROR]", {
    status,
    message: normalizedError.message,
    stack:
      process.env.NODE_ENV === "development"
        ? normalizedError.stack
        : undefined,
  });

  return res.status(status).json({
    ok: false,
    error: normalizedError.message,
  });
}

/**
 * ============================================================
 * RESOURCES
 * ============================================================
 */

router.post(
  "/resources",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const resource = await createFieldOperationResource({
        tenantId,

        name: requiredString(body.name, "name"),

        resourceType: requiredString(
          body.resourceType,
          "resourceType"
        ) as FieldOperationResourceType,

        externalProvider:
          body.externalProvider === undefined
            ? undefined
            : optionalString(body.externalProvider) ?? null,

        externalReference:
          body.externalReference === undefined
            ? undefined
            : optionalString(body.externalReference) ?? null,

        active: optionalBoolean(body.active, "active"),

        startAddress:
          body.startAddress === undefined
            ? undefined
            : optionalString(body.startAddress) ?? null,

        startLatitude: optionalNumber(
          body.startLatitude,
          "startLatitude"
        ),

        startLongitude: optionalNumber(
          body.startLongitude,
          "startLongitude"
        ),

        endAddress:
          body.endAddress === undefined
            ? undefined
            : optionalString(body.endAddress) ?? null,

        endLatitude: optionalNumber(
          body.endLatitude,
          "endLatitude"
        ),

        endLongitude: optionalNumber(
          body.endLongitude,
          "endLongitude"
        ),

        timezone:
          body.timezone === undefined
            ? undefined
            : optionalString(body.timezone) ?? null,

        availability: optionalObject(
          body.availability,
          "availability"
        ),

        capabilities: optionalArray(
          body.capabilities,
          "capabilities"
        ),

        metadata: optionalObject(
          body.metadata,
          "metadata"
        ),
      });

      return res.status(201).json({
        ok: true,
        resource,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/resources",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const resources =
        await listFieldOperationResources({
          tenantId,
          active: optionalBoolean(
            req.query.active,
            "active"
          ),
        });

      return res.json({
        ok: true,
        resources,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/resources/:resourceId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const resource =
        await getFieldOperationResourceById({
          tenantId,
          resourceId: requiredString(
            req.params.resourceId,
            "resourceId"
          ),
        });

      if (!resource) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_RESOURCE_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        resource,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.patch(
  "/resources/:resourceId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const resource =
        await updateFieldOperationResource(
          tenantId,
          requiredString(
            req.params.resourceId,
            "resourceId"
          ),
          {
            name:
              body.name === undefined
                ? undefined
                : requiredString(body.name, "name"),

            resourceType:
              body.resourceType === undefined
                ? undefined
                : (requiredString(
                    body.resourceType,
                    "resourceType"
                  ) as FieldOperationResourceType),

            externalProvider:
              body.externalProvider === undefined
                ? undefined
                : optionalString(
                    body.externalProvider
                  ) ?? null,

            externalReference:
              body.externalReference === undefined
                ? undefined
                : optionalString(
                    body.externalReference
                  ) ?? null,

            active: optionalBoolean(
              body.active,
              "active"
            ),

            startAddress:
              body.startAddress === undefined
                ? undefined
                : optionalString(body.startAddress) ??
                  null,

            startLatitude: optionalNumber(
              body.startLatitude,
              "startLatitude"
            ),

            startLongitude: optionalNumber(
              body.startLongitude,
              "startLongitude"
            ),

            endAddress:
              body.endAddress === undefined
                ? undefined
                : optionalString(body.endAddress) ??
                  null,

            endLatitude: optionalNumber(
              body.endLatitude,
              "endLatitude"
            ),

            endLongitude: optionalNumber(
              body.endLongitude,
              "endLongitude"
            ),

            timezone:
              body.timezone === undefined
                ? undefined
                : optionalString(body.timezone) ??
                  null,

            availability: optionalObject(
              body.availability,
              "availability"
            ),

            capabilities: optionalArray(
              body.capabilities,
              "capabilities"
            ),

            metadata: optionalObject(
              body.metadata,
              "metadata"
            ),
          }
        );

      if (!resource) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_RESOURCE_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        resource,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.delete(
  "/resources/:resourceId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const deactivated =
        await deactivateFieldOperationResource({
          tenantId,
          resourceId: requiredString(
            req.params.resourceId,
            "resourceId"
          ),
        });

      if (!deactivated) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_ACTIVE_RESOURCE_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        deactivated: true,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

/**
 * ============================================================
 * APPOINTMENT LOCATIONS
 * ============================================================
 */

router.put(
  "/appointments/:appointmentId/location",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const location = await setAppointmentFieldLocation({
        tenantId,

        appointmentId: requiredString(
          req.params.appointmentId,
          "appointmentId"
        ),

        locationType: "service",

        formattedAddress: requiredString(
          body.formattedAddress,
          "formattedAddress"
        ),

        addressComponents: optionalObject(
          body.addressComponents,
          "addressComponents"
        ),

        latitude: optionalNumber(
          body.latitude,
          "latitude"
        ),

        longitude: optionalNumber(
          body.longitude,
          "longitude"
        ),

        geocodingProvider:
          body.geocodingProvider === undefined
            ? undefined
            : optionalString(
                body.geocodingProvider
              ) ?? null,

        providerPlaceId:
          body.providerPlaceId === undefined
            ? undefined
            : optionalString(body.providerPlaceId) ??
              null,

        geocodingStatus: optionalString(
          body.geocodingStatus
        ),

        geocodingError:
          body.geocodingError === undefined
            ? undefined
            : optionalString(body.geocodingError) ??
              null,

        metadata: optionalObject(
          body.metadata,
          "metadata"
        ),
      });

      return res.json({
        ok: true,
        location,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/appointments/:appointmentId/location",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const location = await getAppointmentFieldLocation({
        tenantId,
        appointmentId: requiredString(
          req.params.appointmentId,
          "appointmentId"
        ),
      });

      if (!location) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_APPOINTMENT_LOCATION_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        location,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/appointment-locations",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const appointmentIds =
        typeof req.query.appointmentIds === "string"
          ? req.query.appointmentIds
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined;

      const locations =
        await listAppointmentLocations({
          tenantId,
          appointmentIds,
          geocodingStatus: optionalString(
            req.query.geocodingStatus
          ),
        });

      return res.json({
        ok: true,
        locations,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.patch(
  "/appointments/:appointmentId/location/geocoding",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const location =
        await updateAppointmentLocationGeocoding({
          tenantId,

          appointmentId: requiredString(
            req.params.appointmentId,
            "appointmentId"
          ),

          locationType: "service",

          latitude:
            optionalNumber(
              body.latitude,
              "latitude"
            ) ?? null,

          longitude:
            optionalNumber(
              body.longitude,
              "longitude"
            ) ?? null,

          formattedAddress:
            body.formattedAddress === undefined
              ? undefined
              : requiredString(
                  body.formattedAddress,
                  "formattedAddress"
                ),

          addressComponents: optionalObject(
            body.addressComponents,
            "addressComponents"
          ),

          geocodingProvider:
            body.geocodingProvider === undefined
              ? undefined
              : optionalString(
                  body.geocodingProvider
                ) ?? null,

          providerPlaceId:
            body.providerPlaceId === undefined
              ? undefined
              : optionalString(
                  body.providerPlaceId
                ) ?? null,

          geocodingStatus: requiredString(
            body.geocodingStatus,
            "geocodingStatus"
          ),

          geocodingError:
            body.geocodingError === undefined
              ? undefined
              : optionalString(
                  body.geocodingError
                ) ?? null,
        });

      if (!location) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_APPOINTMENT_LOCATION_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        location,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.delete(
  "/appointments/:appointmentId/location",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const deleted = await removeAppointmentFieldLocation({
        tenantId,
        appointmentId: requiredString(
          req.params.appointmentId,
          "appointmentId"
        ),
      });

      if (!deleted) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_APPOINTMENT_LOCATION_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        deleted: true,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

/**
 * ============================================================
 * APPOINTMENT FIELD OPERATIONS SUMMARY
 * ============================================================
 */

router.get(
  "/appointments/:appointmentId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const appointmentId = requiredString(
        req.params.appointmentId,
        "appointmentId"
      );

      const fieldOperations =
        await getAppointmentFieldOperations({
          tenantId,
          appointmentId,
        });

      return res.json({
        ok: true,
        fieldOperations,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

/**
 * ============================================================
 * RESOURCE ASSIGNMENTS
 * ============================================================
 */

router.put(
  "/appointments/:appointmentId/assignments/:resourceId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const assignment = await assignResourceToAppointment({
        tenantId,

        appointmentId: requiredString(
          req.params.appointmentId,
          "appointmentId"
        ),

        resourceId: requiredString(
          req.params.resourceId,
          "resourceId"
        ),

        assignmentRole: optionalString(
          body.assignmentRole
        ),

        assignmentStatus: optionalString(
          body.assignmentStatus
        ),

        metadata: optionalObject(
          body.metadata,
          "metadata"
        ),
      });

      return res.json({
        ok: true,
        assignment,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/assignments",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const assignments =
        await listResourceAssignments({
          tenantId,
          resourceId: optionalString(
            req.query.resourceId
          ),
          appointmentId: optionalString(
            req.query.appointmentId
          ),
          assignmentStatus: optionalString(
            req.query.assignmentStatus
          ),
        });

      return res.json({
        ok: true,
        assignments,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/appointments/:appointmentId/assignments/:resourceId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const assignment =
        await getAppointmentResourceAssignment({
          tenantId,
          appointmentId: requiredString(
            req.params.appointmentId,
            "appointmentId"
          ),
          resourceId: requiredString(
            req.params.resourceId,
            "resourceId"
          ),
          assignmentRole: optionalString(
            req.query.assignmentRole
          ),
        });

      if (!assignment) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_ASSIGNMENT_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        assignment,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.patch(
  "/appointments/:appointmentId/assignments/:resourceId/status",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const assignment =
        await changeAppointmentResourceStatus({
          tenantId,

          appointmentId: requiredString(
            req.params.appointmentId,
            "appointmentId"
          ),

          resourceId: requiredString(
            req.params.resourceId,
            "resourceId"
          ),

          assignmentRole: optionalString(
            body.assignmentRole
          ),

          assignmentStatus: requiredString(
            body.assignmentStatus,
            "assignmentStatus"
          ),
        });

      return res.json({
        ok: true,
        assignment,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.delete(
  "/appointments/:appointmentId/assignments/:resourceId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const deleted = await removeResourceFromAppointment({
        tenantId,
        appointmentId: requiredString(
          req.params.appointmentId,
          "appointmentId"
        ),
        resourceId: requiredString(
          req.params.resourceId,
          "resourceId"
        ),
        assignmentRole: optionalString(
          req.query.assignmentRole
        ),
      });

      if (!deleted) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_ASSIGNMENT_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        deleted: true,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

/**
 * ============================================================
 * ROUTE PLANS
 * ============================================================
 */

router.post(
  "/route-plans",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const routePlan = await saveRoutePlan({
        tenantId,

        resourceId: requiredString(
          body.resourceId,
          "resourceId"
        ),

        serviceDate: requiredString(
          body.serviceDate,
          "serviceDate"
        ),

        mode: "view_only",
        status: "draft",

        optimizationRequest: optionalObject(
          body.optimizationRequest,
          "optimizationRequest"
        ),
      });

      return res.status(201).json({
        ok: true,
        routePlan,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/route-plans",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const routePlans = await listRoutePlans({
        tenantId,
        serviceDate: optionalString(
          req.query.serviceDate
        ),
        resourceId: optionalString(
          req.query.resourceId
        ),
      });

      return res.json({
        ok: true,
        routePlans,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/route-plans/by-resource/:resourceId/:serviceDate",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const routePlan =
        await getRoutePlanByResourceAndDate({
          tenantId,
          resourceId: requiredString(
            req.params.resourceId,
            "resourceId"
          ),
          serviceDate: requiredString(
            req.params.serviceDate,
            "serviceDate"
          ),
        });

      if (!routePlan) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_ROUTE_PLAN_NOT_FOUND",
        });
      }

      return res.json({
        ok: true,
        routePlan,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.get(
  "/route-plans/:routePlanId",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);

      const routePlan = await getRoutePlanById({
        tenantId,
        routePlanId: requiredString(
          req.params.routePlanId,
          "routePlanId"
        ),
      });

      if (!routePlan) {
        return res.status(404).json({
          ok: false,
          error:
            "FIELD_OPERATIONS_ROUTE_PLAN_NOT_FOUND",
        });
      }

      const stops = await listRoutePlanStops({
        tenantId,
        routePlanId: routePlan.id,
      });

      return res.json({
        ok: true,
        routePlan,
        stops,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.post(
  "/route-plans/build",
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const result =
        await buildRoutePlan({
          tenantId,

          resourceId: requiredString(
            body.resourceId,
            "resourceId"
          ),

          serviceDate: requiredString(
            body.serviceDate,
            "serviceDate"
          ),

          mode:
            optionalString(body.mode) === undefined
              ? undefined
              : (optionalString(body.mode) as any),
        });

      return res.status(201).json({
        ok: true,

        routePlan: result.routePlan,
        stops: result.stops,
        skippedAppointments:
          result.skippedAppointments,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

router.post(
  "/route-plans/:routePlanId/optimize",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      const body = req.body ?? {};

      const routePlan = await optimizeRoutePlan({
        tenantId,

        routePlanId: requiredString(
          req.params.routePlanId,
          "routePlanId"
        ),

        providerName: optionalString(
          body.providerName
        ),

        routeStartAt:
          body.routeStartAt === null ||
          body.routeStartAt === undefined
            ? null
            : String(body.routeStartAt),

        stops: parseRoutingStops(body.stops),

        options: {
          preserveScheduledOrder:
            optionalBoolean(
              body.options?.preserveScheduledOrder,
              "options.preserveScheduledOrder"
            ) ?? false,

          returnToStart:
            optionalBoolean(
              body.options?.returnToStart,
              "options.returnToStart"
            ) ?? false,

          averageSpeedKph:
            optionalNumber(
              body.options?.averageSpeedKph,
              "options.averageSpeedKph"
            ) ?? undefined,
        },

        metadata: optionalObject(
          body.metadata,
          "metadata"
        ),
      });

      const stops = await listRoutePlanStops({
        tenantId,
        routePlanId: routePlan.id,
      });

      return res.json({
        ok: true,
        routePlan,
        stops,
      });
    } catch (error) {
      return handleError(res, error);
    }
  }
);

export default router;