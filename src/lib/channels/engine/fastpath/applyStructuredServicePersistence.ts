//src/lib/channels/engine/fastpath/applyStructuredServicePersistence.ts
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

function hasConcreteCatalogScope(ctxPatch: any): boolean {
  const scope = String(ctxPatch?.last_catalog_scope || "")
    .trim()
    .toLowerCase();

  return scope === "entity" || scope === "variant" || scope === "family";
}

export function applyStructuredServicePersistence(
  input: ApplyStructuredServicePersistenceInput
): any {
  const { shouldPersistStructuredService, structuredService, ctxPatch } = input;

  if (!shouldPersistStructuredService) {
    return ctxPatch;
  }

  const nextCtxPatch = { ...(ctxPatch || {}) };

  // No persistir selección puntual si no hay resolución real
  if (!structuredService?.hasResolution || !structuredService?.serviceId) {
    return nextCtxPatch;
  }

  nextCtxPatch.last_service_id = structuredService.serviceId;
  nextCtxPatch.selectedServiceId = structuredService.serviceId;

  if (structuredService.serviceName) {
    nextCtxPatch.last_service_name = structuredService.serviceName;
    nextCtxPatch.selectedServiceName = structuredService.serviceName;
  }

  if (structuredService.serviceLabel) {
    nextCtxPatch.last_service_label = structuredService.serviceLabel;
    nextCtxPatch.selectedServiceLabel = structuredService.serviceLabel;
  }

  // Solo marcar entidad puntual cuando el contexto realmente lo amerita.
  // No queremos que un overview general termine convertido artificialmente
  // en una selección de servicio.
  if (hasConcreteCatalogScope(nextCtxPatch)) {
    nextCtxPatch.last_entity_kind = "service";
    nextCtxPatch.last_entity_at = Date.now();
  }

  return nextCtxPatch;
}