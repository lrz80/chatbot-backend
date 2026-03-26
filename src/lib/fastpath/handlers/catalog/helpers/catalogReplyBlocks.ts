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
  return "";
}

export function getCatalogClosingLine(idiomaDestino: string): string {
  return "";
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

  return blocks.join("\n\n");
}