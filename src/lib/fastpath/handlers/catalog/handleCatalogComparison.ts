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

type CatalogComparisonRow = {
  id: string;
  name: string;
  description: string;
  minPrice: number | null;
  maxPrice: number | null;
};

function uniqueOrderedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of value) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
}

function formatPriceText(
  minPrice: number | null,
  maxPrice: number | null,
  lang: "es" | "en"
): string {
  if (Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
    if (minPrice === maxPrice) {
      return `$${minPrice!.toFixed(2)}`;
    }

    return lang === "en"
      ? `from $${minPrice!.toFixed(2)}`
      : `desde $${minPrice!.toFixed(2)}`;
  }

  if (Number.isFinite(minPrice)) {
    return lang === "en"
      ? `from $${minPrice!.toFixed(2)}`
      : `desde $${minPrice!.toFixed(2)}`;
  }

  return "";
}

function buildCanonicalList(
  items: CatalogComparisonRow[],
  lang: "es" | "en"
): string {
  return items
    .map((item) => {
      const priceText = formatPriceText(item.minPrice, item.maxPrice, lang);

      return [
        priceText ? `• ${item.name}: ${priceText}` : `• ${item.name}`,
        item.description ? `  - ${item.description}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export async function handleCatalogComparison(
  input: HandleCatalogComparisonInput
): Promise<FastpathResult> {
  const llmLang: "es" | "en" =
    input.idiomaDestino === "en" ? "en" : "es";

  const ids = uniqueOrderedIds(
    input.catalogReferenceClassification?.targetServiceIds
  );

  if (ids.length < 2) {
    return { handled: false };
  }

  const { rows } = await input.pool.query(
    `
      SELECT
        s.id,
        s.name,
        s.description,
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

  const byId = new Map<string, CatalogComparisonRow>();

  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id) continue;

    byId.set(id, {
      id,
      name: String(row?.name || "").trim(),
      description: String(row?.description || "").trim(),
      minPrice: row?.min_price === null ? null : Number(row?.min_price),
      maxPrice: row?.max_price === null ? null : Number(row?.max_price),
    });
  }

  const ordered: CatalogComparisonRow[] = ids
    .map((id) => byId.get(id))
    .filter((item): item is CatalogComparisonRow => Boolean(item));

  if (ordered.length < 2) {
    return { handled: false };
  }

  if (ordered.length > 2) {
    const canonicalReply = buildCanonicalList(ordered, llmLang);

    const reply =
      (await input.answerCatalogQuestionLLM({
        idiomaDestino: llmLang,
        canonicalReply,
        userInput: input.userInput,
        mode: "grounded_frame_only",
        renderIntent: "catalog_list",
        comparisonItems: ordered.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          minPrice: item.minPrice,
          maxPrice: item.maxPrice,
        })),
        maxIntroLines: 1,
        maxClosingLines: 1,
      })) || canonicalReply;

    return {
      handled: true,
      source: "catalog_comparison_needs_disambiguation" as any,
      intent: "info_servicio",
      reply,
      ctxPatch: {
        lastResolvedIntent: "compare",
        comparisonCandidateServiceIds: ordered.map((item) => item.id),
      },
    };
  }

  const canonicalReply = buildCanonicalList(ordered, llmLang);

  const reply =
    (await input.answerCatalogQuestionLLM({
      idiomaDestino: llmLang,
      canonicalReply,
      userInput: input.userInput,
      mode: "grounded_catalog_sales",
      renderIntent: "catalog_compare",
      comparisonItems: ordered.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        minPrice: item.minPrice,
        maxPrice: item.maxPrice,
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