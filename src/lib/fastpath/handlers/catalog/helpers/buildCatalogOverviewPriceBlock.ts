//src/lib/fastpath/handlers/catalog/helpers/buildCatalogOverviewPriceBlock.ts
import type { Pool } from "pg";
import { buildPriceBlock } from "./catalogPriceBlock";

type CatalogPriceRow = {
  service_id: string;
  service_name: string;
  min_price: number | string | null;
  max_price: number | string | null;
  parent_service_id: string | null;
  category: string | null;
  catalog_role: string | null;
};

type BuildCatalogOverviewPriceBlockInput = {
  pool: Pool;
  tenantId: string;
  idiomaDestino: string;
  normalizeCatalogRole: (value: string | null | undefined) => string;
  traducirTexto: (
    texto: string,
    idiomaDestino: string,
    modo?: any
  ) => Promise<string>;
  renderGenericPriceSummaryReply: (input: {
    lang: any;
    rows: any[];
  }) => string;
};

export async function buildCatalogOverviewPriceBlock(
  input: BuildCatalogOverviewPriceBlockInput
): Promise<{
  rows: CatalogPriceRow[];
  rowsLocalized: CatalogPriceRow[];
  priceBlock: string;
}> {
  const { rows } = await input.pool.query<CatalogPriceRow>(
    `
    WITH variant_prices AS (
      SELECT
        s.id AS service_id,
        s.name AS service_name,
        s.parent_service_id,
        s.category,
        s.catalog_role,
        MIN(v.price)::numeric AS min_price,
        MAX(v.price)::numeric AS max_price
      FROM services s
      JOIN service_variants v
        ON v.service_id = s.id
       AND v.active = true
      WHERE s.tenant_id = $1
        AND s.active = true
        AND v.price IS NOT NULL
      GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
    ),
    base_prices AS (
      SELECT
        s.id AS service_id,
        s.name AS service_name,
        s.parent_service_id,
        s.category,
        s.catalog_role,
        MIN(s.price_base)::numeric AS min_price,
        MAX(s.price_base)::numeric AS max_price
      FROM services s
      WHERE s.tenant_id = $1
        AND s.active = true
        AND s.price_base IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM service_variants v
          WHERE v.service_id = s.id
            AND v.active = true
            AND v.price IS NOT NULL
        )
      GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
    )
    SELECT
      service_id,
      service_name,
      min_price,
      max_price,
      parent_service_id,
      category,
      catalog_role
    FROM (
      SELECT
        service_id,
        service_name,
        min_price,
        max_price,
        parent_service_id,
        category,
        catalog_role
      FROM variant_prices

      UNION ALL

      SELECT
        service_id,
        service_name,
        min_price,
        max_price,
        parent_service_id,
        category,
        catalog_role
      FROM base_prices
    ) x;
    `,
    [input.tenantId]
  );

  const rowsPrioritized = [...rows].sort((a, b) => {
    const aRole = input.normalizeCatalogRole(a.catalog_role);
    const bRole = input.normalizeCatalogRole(b.catalog_role);

    const aPrimary = aRole === "primary";
    const bPrimary = bRole === "primary";

    if (aPrimary !== bPrimary) {
      return aPrimary ? -1 : 1;
    }

    const aSortPrice =
      a.min_price === null ? Number.NEGATIVE_INFINITY : Number(a.min_price);
    const bSortPrice =
      b.min_price === null ? Number.NEGATIVE_INFINITY : Number(b.min_price);

    if (aSortPrice !== bSortPrice) {
      return bSortPrice - aSortPrice;
    }

    return String(a.service_name || "").localeCompare(
      String(b.service_name || "")
    );
  });

  let rowsLocalized = rowsPrioritized;

  if (input.idiomaDestino === "en") {
    rowsLocalized = await Promise.all(
      rowsPrioritized.map(async (row) => {
        const nameEs = String(row.service_name || "").trim();
        if (!nameEs) return row;

        try {
          const nameEn = await input.traducirTexto(
            nameEs,
            "en",
            "catalog_label"
          );

          return {
            ...row,
            service_name: nameEn,
          };
        } catch {
          return row;
        }
      })
    );
  }

  const priceBlock = buildPriceBlock({
    idiomaDestino: input.idiomaDestino,
    rows: rowsLocalized,
    renderGenericPriceSummaryReply: input.renderGenericPriceSummaryReply,
  });

  return {
    rows: rowsPrioritized,
    rowsLocalized,
    priceBlock,
  };
}