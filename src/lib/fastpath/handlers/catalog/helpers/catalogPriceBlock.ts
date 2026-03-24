// src/lib/fastpath/handlers/catalog/helpers/catalogPriceBlock.ts

export type CatalogPriceRow = {
  service_name: string;
  min_price: number | string | null;
  max_price: number | string | null;
};

export function buildPriceBlock(input: {
  idiomaDestino: string;
  rows: CatalogPriceRow[];
  renderGenericPriceSummaryReply: (args: {
    lang: any;
    rows: CatalogPriceRow[];
  }) => string;
}): string {
  const reply = input.renderGenericPriceSummaryReply({
    lang: input.idiomaDestino,
    rows: input.rows,
  });

  return String(reply || "").trim();
}