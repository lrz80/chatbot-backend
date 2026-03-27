export type StructuredServiceSelection = {
  serviceId: string | null;
  serviceName: string | null;
  serviceLabel: string | null;
  hasResolution: boolean;
};

export type GetStructuredServiceForFastpathInput = {
  fp: {
    source?: string | null;
    intent?: string | null;
  };
  catalogRoutingSignal?: any;
  catalogReferenceClassification?: any;
  ctxPatch?: any;
  convoCtxForFastpath?: any;
};

function firstNonEmptyString(...values: any[]): string | null {
  for (const value of values) {
    const v = String(value ?? "").trim();
    if (v) return v;
  }
  return null;
}

function shouldUseRoutingStructuredService(signal: any): boolean {
  return Boolean(
    signal?.targetServiceId &&
      (
        String(signal?.targetLevel || "").trim().toLowerCase() === "service" ||
        String(signal?.targetLevel || "").trim().toLowerCase() === "variant"
      )
  );
}

function getStructuredServiceSelection(ctxPatch: any, convoCtx: any): StructuredServiceSelection {
  const serviceId = firstNonEmptyString(
    ctxPatch?.last_service_id,
    ctxPatch?.selectedServiceId,
    ctxPatch?.selected_service_id,
    ctxPatch?.serviceId,
    convoCtx?.last_service_id,
    convoCtx?.selectedServiceId,
    convoCtx?.selected_service_id,
    convoCtx?.serviceId
  );

  const serviceName = firstNonEmptyString(
    ctxPatch?.last_service_name,
    ctxPatch?.selectedServiceName,
    ctxPatch?.selected_service_name,
    ctxPatch?.serviceName,
    convoCtx?.last_service_name,
    convoCtx?.selectedServiceName,
    convoCtx?.selected_service_name,
    convoCtx?.serviceName
  );

  const serviceLabel = firstNonEmptyString(
    ctxPatch?.last_service_label,
    ctxPatch?.selectedServiceLabel,
    ctxPatch?.selected_service_label,
    ctxPatch?.serviceLabel,
    convoCtx?.last_service_label,
    convoCtx?.selectedServiceLabel,
    convoCtx?.selected_service_label,
    convoCtx?.serviceLabel,
    serviceName
  );

  return {
    serviceId,
    serviceName,
    serviceLabel,
    hasResolution: Boolean(serviceId || serviceName || serviceLabel),
  };
}

export function getStructuredServiceForFastpath(
  input: GetStructuredServiceForFastpathInput
): StructuredServiceSelection {
  const fpSource = String(input.fp?.source || "").trim();
  const fpIntent = String(input.fp?.intent || "").trim();

  const shouldUseConvoCtxForStructuredService =
    fpSource === "price_fastpath_db_llm_render" ||
    fpSource === "price_fastpath_db_no_price_llm_render" ||
    fpSource === "price_fastpath_db" ||
    fpSource === "price_disambiguation_db" ||
    fpSource === "price_missing_db" ||
    (fpSource === "service_list_db" && fpIntent === "info_servicio");

  const canUseRoutingStructuredService =
    shouldUseRoutingStructuredService(input.catalogRoutingSignal);

  const routingTargetServiceId = canUseRoutingStructuredService
    ? firstNonEmptyString(
        input.catalogRoutingSignal?.targetServiceId,
        input.catalogReferenceClassification?.targetServiceId
      )
    : null;

  const routingTargetServiceName = canUseRoutingStructuredService
    ? firstNonEmptyString(
        input.catalogRoutingSignal?.targetServiceName,
        input.catalogReferenceClassification?.targetServiceName
      )
    : null;

  const routingStructuredService =
    routingTargetServiceId || routingTargetServiceName
      ? {
          serviceId: routingTargetServiceId,
          serviceName: routingTargetServiceName,
          serviceLabel: routingTargetServiceName,
          hasResolution: true,
        }
      : null;

  const structuredServiceBase = routingStructuredService
    ? routingStructuredService
    : shouldUseConvoCtxForStructuredService
    ? getStructuredServiceSelection(input.ctxPatch, input.convoCtxForFastpath)
    : getStructuredServiceSelection(input.ctxPatch, {});

  const shouldIgnoreStructuredService =
    fpSource === "price_disambiguation_db";

  let structuredService = shouldIgnoreStructuredService
    ? {
        serviceId: null,
        serviceName: null,
        serviceLabel: null,
        hasResolution: false,
      }
    : structuredServiceBase;

  if (input.catalogReferenceClassification?.kind === "comparison") {
    structuredService = {
      serviceId: null,
      serviceName: null,
      serviceLabel: null,
      hasResolution: false,
    };
  }

  return structuredService;
}