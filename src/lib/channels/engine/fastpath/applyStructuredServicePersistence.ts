export type ApplyStructuredServicePersistenceInput = {
  shouldPersistStructuredService: boolean;
  structuredService: {
    serviceId: string | null;
    serviceName: string | null;
    serviceLabel: string | null;
    hasResolution: boolean;
  };
  ctxPatch: any;
};

export function applyStructuredServicePersistence(
  input: ApplyStructuredServicePersistenceInput
): any {
  const { shouldPersistStructuredService, structuredService, ctxPatch } = input;

  if (!shouldPersistStructuredService) {
    return ctxPatch;
  }

  const nextCtxPatch = { ...(ctxPatch || {}) };

  if (structuredService.serviceId) {
    nextCtxPatch.last_service_id = structuredService.serviceId;
    nextCtxPatch.selectedServiceId = structuredService.serviceId;
  }

  if (structuredService.serviceName) {
    nextCtxPatch.last_service_name = structuredService.serviceName;
    nextCtxPatch.selectedServiceName = structuredService.serviceName;
  }

  if (structuredService.serviceLabel) {
    nextCtxPatch.last_service_label = structuredService.serviceLabel;
    nextCtxPatch.selectedServiceLabel = structuredService.serviceLabel;
  }

  nextCtxPatch.last_entity_kind = "service";
  nextCtxPatch.last_entity_at = Date.now();

  return nextCtxPatch;
}