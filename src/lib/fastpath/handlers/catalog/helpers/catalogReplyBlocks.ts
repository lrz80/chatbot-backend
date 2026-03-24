// src/lib/fastpath/handlers/catalog/helpers/catalogReplyBlocks.ts

export type CatalogReplyBlocksInput = {
  idiomaDestino: string;
  asksPrices: boolean;
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
  priceBlock?: string | null;
  scheduleBlock?: string | null;
  locationBlock?: string | null;
  availabilityBlock?: string | null;
  includeClosingLine?: boolean;
};

export function getCatalogOpeningLine(input: {
  idiomaDestino: string;
  asksPrices: boolean;
  asksSchedules: boolean;
  asksLocation: boolean;
  asksAvailability: boolean;
}): string {
  const {
    idiomaDestino,
    asksPrices,
    asksSchedules,
    asksLocation,
    asksAvailability,
  } = input;

  if (idiomaDestino === "en") {
    if (asksPrices && asksSchedules) {
      return "Of course — here are the schedules and prices so you can compare the available options.";
    }

    if (asksPrices && asksLocation) {
      return "Of course — here are the prices and location details you asked for.";
    }

    if (asksSchedules && asksLocation) {
      return "Of course — here are the schedules and location details you asked for.";
    }

    if (asksPrices) {
      return "Of course — here are some price options for you to review.";
    }

    if (asksSchedules) {
      return "Of course — here are the schedules.";
    }

    if (asksLocation) {
      return "Of course — here is the location information.";
    }

    if (asksAvailability) {
      return "Of course — here is the availability information.";
    }

    return "Of course — here is the information you asked for.";
  }

  if (asksPrices && asksSchedules) {
    return "Claro, aquí tienes los horarios y precios para que compares las opciones disponibles.";
  }

  if (asksPrices && asksLocation) {
    return "Claro, aquí tienes los precios y la ubicación que me pediste.";
  }

  if (asksSchedules && asksLocation) {
    return "Claro, aquí tienes los horarios y la ubicación que me pediste.";
  }

  if (asksPrices) {
    return "Claro, aquí tienes algunas opciones con precio para que las revises.";
  }

  if (asksSchedules) {
    return "Claro, aquí tienes los horarios.";
  }

  if (asksLocation) {
    return "Claro, aquí tienes la información de ubicación.";
  }

  if (asksAvailability) {
    return "Claro, aquí tienes la información de disponibilidad.";
  }

  return "Claro, aquí tienes la información que me pediste.";
}

export function getCatalogClosingLine(idiomaDestino: string): string {
  return idiomaDestino === "en"
    ? "If you'd like, I can help you identify which option fits you best."
    : "Si quieres, te ayudo a identificar qué opción te conviene más.";
}

export function withSectionTitle(
  idiomaDestino: string,
  titleEs: string,
  titleEn: string,
  body?: string | null
): string {
  const content = String(body || "").trim();
  if (!content) return "";

  const title = idiomaDestino === "en" ? titleEn : titleEs;
  return `${title}\n${content}`;
}

export function composeCatalogReplyBlocks(
  input: CatalogReplyBlocksInput
): string {
  const blocks = [
    input.priceBlock,
    input.scheduleBlock,
    input.locationBlock,
    input.availabilityBlock,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const parts = [
    getCatalogOpeningLine({
      idiomaDestino: input.idiomaDestino,
      asksPrices: input.asksPrices,
      asksSchedules: input.asksSchedules,
      asksLocation: input.asksLocation,
      asksAvailability: input.asksAvailability,
    }),
    ...blocks,
    input.includeClosingLine === false
      ? ""
      : getCatalogClosingLine(input.idiomaDestino),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return parts.join("\n\n");
}