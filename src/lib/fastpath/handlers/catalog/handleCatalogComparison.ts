import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";

type HandleCatalogComparisonInput = {
  pool: Pool;
  tenantId: string;
  idiomaDestino: string;
  userInput: string;
  catalogReferenceClassification: any;
  answerCatalogQuestionLLM: (input: {
    idiomaDestino: "es" | "en";
    canonicalReply: string;
    userInput: string;
    mode?: "grounded_frame_only" | "grounded_catalog_sales";
    renderIntent?: "catalog_compare" | "catalog_detail" | "catalog_list";
    comparisonItems?: Array<{
      id: string;
      name: string;
      description: string;
      minPrice: number | null;
      maxPrice: number | null;
    }>;
    maxIntroLines?: number;
    maxClosingLines?: number;
  }) => Promise<string | null>;
};

export async function handleCatalogComparison(
  input: HandleCatalogComparisonInput
): Promise<FastpathResult> {
  const llmLang: "es" | "en" =
    input.idiomaDestino === "en" ? "en" : "es";

  const ids = Array.isArray(input.catalogReferenceClassification?.targetServiceIds)
    ? input.catalogReferenceClassification.targetServiceIds.slice(0, 6)
    : [];

  if (ids.length < 2) {
    return { handled: false };
  }

  const { rows } = await input.pool.query(
    `
      SELECT
        s.id,
        s.name,
        s.description,
        s.price_base,
        COALESCE(MIN(v.price), s.price_base) AS min_price,
        COALESCE(MAX(v.price), s.price_base) AS max_price
      FROM services s
      LEFT JOIN service_variants v
        ON v.service_id = s.id
       AND v.active = true
      WHERE s.tenant_id = $1
        AND s.id = ANY($2::uuid[])
        AND s.active = true
      GROUP BY s.id, s.name, s.description, s.price_base
    `,
    [input.tenantId, ids]
  );

  if (!Array.isArray(rows) || rows.length < 2) {
    return { handled: false };
  }

  const byId = new Map(rows.map((row: any) => [String(row.id), row]));
  const ordered = ids.map((id: string) => byId.get(String(id))).filter(Boolean);

  const canonicalReply = ordered
    .map((row: any) => {
      const name = String(row?.name || "").trim();
      const description = String(row?.description || "").trim();
      const min = row?.min_price === null ? null : Number(row?.min_price);
      const max = row?.max_price === null ? null : Number(row?.max_price);

      let priceText =
        llmLang === "en"
          ? "price not available"
          : "precio no disponible";

      if (Number.isFinite(min) && Number.isFinite(max)) {
        priceText =
          min === max
            ? `$${min!.toFixed(2)}`
            : llmLang === "en"
            ? `from $${min!.toFixed(2)}`
            : `desde $${min!.toFixed(2)}`;
      } else if (Number.isFinite(min)) {
        priceText =
          llmLang === "en"
            ? `from $${min!.toFixed(2)}`
            : `desde $${min!.toFixed(2)}`;
      }

      return [
        `• ${name}: ${priceText}`,
        description ? `  - ${description}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const reply =
    (await input.answerCatalogQuestionLLM({
        idiomaDestino: llmLang,
        canonicalReply,
        userInput: input.userInput,
        mode: "grounded_catalog_sales",
        renderIntent: "catalog_compare",
        comparisonItems: ordered.map((row: any) => ({
        id: String(row?.id || ""),
        name: String(row?.name || "").trim(),
        description: String(row?.description || "").trim(),
        minPrice:
            row?.min_price === null ? null : Number(row?.min_price),
        maxPrice:
            row?.max_price === null ? null : Number(row?.max_price),
        })),
        maxIntroLines: 1,
        maxClosingLines: 1,
    })) || canonicalReply;

  return {
    handled: true,
    source: "catalog_comparison_db_llm_render" as any,
    intent: "info_servicio",
    reply,
    ctxPatch: {
      lastResolvedIntent: "compare",
    },
  };
}