type CatalogFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

type CatalogChoiceOption =
  | {
      kind: "service";
      serviceId: string;
      label: string;
      serviceName?: string | null;
    }
  | {
      kind: "variant";
      serviceId: string;
      variantId: string;
      label: string;
      serviceName?: string | null;
      variantName?: string | null;
    };

type CatalogPayload =
  | {
      kind: "service_choice";
      originalIntent: string | null;
      options: CatalogChoiceOption[];
    }
  | {
      kind: "variant_choice";
      originalIntent: string | null;
      serviceId: string;
      serviceName: string | null;
      options: CatalogChoiceOption[];
    }
  | {
      kind: "resolved_catalog_answer";
      scope: "service" | "variant" | "family" | "overview";
      serviceId?: string | null;
      serviceName?: string | null;
      variantId?: string | null;
      variantName?: string | null;
      canonicalBlocks: {
        priceBlock?: string | null;
        includesBlock?: string | null;
        scheduleBlock?: string | null;
        locationBlock?: string | null;
        availabilityBlock?: string | null;
        servicesBlock?: string | null;
      };
    };

type FastpathResolvedShape = {
  intent?: string | null;
  source?: string | null;
  catalogPayload?: CatalogPayload | null;
};

type ResolveFinalIntentFromTurnInput = {
  detectedIntent?: string | null;
  intentFallback?: string | null;
  fp?: FastpathResolvedShape | null;
  facets?: CatalogFacets | null;
  catalogRoutingSignal?: {
    routeIntent?: string | null;
    targetLevel?: string | null;
  } | null;
  catalogReferenceClassification?: {
    intent?: string | null;
    kind?: string | null;
  } | null;
};

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function hasText(value: unknown): boolean {
  return normalize(value).length > 0;
}

function resolveIntentFromCatalogPayload(
  catalogPayload: CatalogPayload | null | undefined
): string | null {
  if (!catalogPayload) {
    return null;
  }

  if (catalogPayload.kind === "service_choice") {
    return "service_choice";
  }

  if (catalogPayload.kind === "variant_choice") {
    return "variant_choice";
  }

  if (catalogPayload.kind === "resolved_catalog_answer") {
    const blocks = catalogPayload.canonicalBlocks || {};

    if (hasText(blocks.priceBlock)) {
      return "precio";
    }

    if (hasText(blocks.includesBlock)) {
      return "info_servicio";
    }

    if (hasText(blocks.scheduleBlock)) {
      return "horario";
    }

    if (hasText(blocks.locationBlock)) {
      return "ubicacion";
    }

    if (hasText(blocks.availabilityBlock)) {
      return "disponibilidad";
    }

    if (hasText(blocks.servicesBlock)) {
      return "info_general";
    }

    return "info_servicio";
  }

  return null;
}

export function resolveFinalIntentFromTurn(
  input: ResolveFinalIntentFromTurnInput
): string {
  const detectedIntent = normalize(input.detectedIntent);
  const intentFallback = normalize(input.intentFallback);

  const fpIntent = normalize(input.fp?.intent);
  const fpSource = normalize(input.fp?.source);
  const payloadIntent = resolveIntentFromCatalogPayload(input.fp?.catalogPayload);

  const asksPrices = Boolean(input.facets?.asksPrices);
  const asksSchedules = Boolean(input.facets?.asksSchedules);
  const asksLocation = Boolean(input.facets?.asksLocation);
  const asksAvailability = Boolean(input.facets?.asksAvailability);

  const routeIntent = normalize(input.catalogRoutingSignal?.routeIntent);
  const classificationIntent = normalize(
    input.catalogReferenceClassification?.intent
  );
  const classificationKind = normalize(
    input.catalogReferenceClassification?.kind
  );
  const targetLevel = normalize(input.catalogRoutingSignal?.targetLevel);

  // 1) autoridad final: intent ya ensamblado por fastpath
  if (hasText(fpIntent)) {
    return fpIntent;
  }

  // 2) segunda autoridad: payload estructurado ya ensamblado por catálogo
  if (payloadIntent) {
    return payloadIntent;
  }

  // 3) solo si no hubo ensamblado, usar señales secundarias
  if (
    routeIntent === "catalog_price" ||
    routeIntent === "catalog_alternatives" ||
    classificationIntent === "price_or_plan"
  ) {
    return "precio";
  }

  if (
    fpSource === "price_summary_db" ||
    fpSource === "price_fastpath_db" ||
    fpSource === "price_disambiguation_db" ||
    fpSource === "price_fastpath_db_no_price"
  ) {
    return "precio";
  }

  if (routeIntent === "catalog_schedule" || asksSchedules) {
    return "horario";
  }

  if (asksLocation) {
    return "ubicacion";
  }

  if (asksAvailability) {
    return "disponibilidad";
  }

  if (
    routeIntent === "catalog_includes" ||
    classificationIntent === "includes" ||
    classificationKind === "entity_specific" ||
    classificationKind === "variant_specific" ||
    classificationKind === "referential_followup" ||
    targetLevel === "service" ||
    targetLevel === "variant"
  ) {
    return "info_servicio";
  }

  if (
    classificationKind === "catalog_overview" ||
    classificationKind === "catalog_family" ||
    targetLevel === "catalog" ||
    targetLevel === "family" ||
    targetLevel === "multi_service"
  ) {
    if (asksPrices) return "precio";
    return "catalogo";
  }

  if (asksPrices) return "precio";
  if (asksSchedules) return "horario";
  if (asksLocation) return "ubicacion";
  if (asksAvailability) return "disponibilidad";

  return detectedIntent || intentFallback || "duda";
}