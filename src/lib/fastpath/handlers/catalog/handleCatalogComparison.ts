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

type ComparisonSide = {
  label: string;
  serviceIds: string[];
  serviceNames: string[];
  serviceLabels: string[];
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

  return lang === "en" ? "price not available" : "precio no disponible";
}

function normalizeSide(raw: any): ComparisonSide | null {
  const serviceIds = uniqueOrderedIds(raw?.serviceIds);
  if (!serviceIds.length) return null;

  const serviceNames = Array.isArray(raw?.serviceNames)
    ? raw.serviceNames.map((v: unknown) => String(v || "").trim())
    : [];

  const serviceLabels = Array.isArray(raw?.serviceLabels)
    ? raw.serviceLabels.map((v: unknown) => String(v || "").trim())
    : [];

  return {
    label: String(raw?.label || "").trim(),
    serviceIds,
    serviceNames,
    serviceLabels,
  };
}

function getStructuredSides(input: any): ComparisonSide[] {
  const rawSides = Array.isArray(input?.catalogReferenceClassification?.structuredComparison?.sides)
    ? input.catalogReferenceClassification.structuredComparison.sides
    : [];

  return rawSides
    .map((side: any) => normalizeSide(side))
    .filter((side: ComparisonSide | null): side is ComparisonSide => Boolean(side));
}

function buildRowMap(rows: any[]): Map<string, CatalogComparisonRow> {
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

  return byId;
}

function getRowsForSide(
  side: ComparisonSide,
  byId: Map<string, CatalogComparisonRow>
): CatalogComparisonRow[] {
  return side.serviceIds
    .map((id) => byId.get(id))
    .filter((item): item is CatalogComparisonRow => Boolean(item));
}

function buildSideSummary(
  side: ComparisonSide,
  rows: CatalogComparisonRow[],
  lang: "es" | "en"
): string {
  const title =
    side.label ||
    rows[0]?.name ||
    (lang === "en" ? "Option group" : "Grupo de opciones");

  const lines = rows.map((row) => {
    const priceText = formatPriceText(row.minPrice, row.maxPrice, lang);

    return [
      priceText ? `• ${row.name}: ${priceText}` : `• ${row.name}`,
      row.description ? `  - ${row.description}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  if (lang === "en") {
    return [`Group: ${title}`, ...lines].join("\n");
  }

  return [`Grupo: ${title}`, ...lines].join("\n");
}

function buildGroupedComparisonCanonicalReply(
  leftSide: ComparisonSide,
  leftRows: CatalogComparisonRow[],
  rightSide: ComparisonSide,
  rightRows: CatalogComparisonRow[],
  lang: "es" | "en"
): string {
  const leftTitle =
    leftSide.label || leftRows[0]?.name || (lang === "en" ? "Left side" : "Lado izquierdo");
  const rightTitle =
    rightSide.label || rightRows[0]?.name || (lang === "en" ? "Right side" : "Lado derecho");

  if (lang === "en") {
    return [
      `Compare these two catalog groups: ${leftTitle} vs ${rightTitle}.`,
      `Explain the main differences only, using grounded data.`,
      `Do not answer as an independent catalog list.`,
      `If one side contains multiple plans, summarize what that group usually includes and how it differs from the other side.`,
      ``,
      buildSideSummary(leftSide, leftRows, lang),
      ``,
      buildSideSummary(rightSide, rightRows, lang),
      ``,
      `Output requirements:`,
      `• Start with the main difference in one short paragraph.`,
      `• Then explain what ${leftTitle} includes.`,
      `• Then explain what ${rightTitle} includes as a group.`,
      `• End with who each option is best for.`,
    ].join("\n");
  }

  return [
    `Compara estos dos grupos del catálogo: ${leftTitle} vs ${rightTitle}.`,
    `Explica solo las diferencias principales usando datos grounded.`,
    `No respondas como una lista independiente de catálogo.`,
    `Si un lado contiene varios planes, resume qué suele incluir ese grupo y cómo se diferencia del otro lado.`,
    ``,
    buildSideSummary(leftSide, leftRows, lang),
    ``,
    buildSideSummary(rightSide, rightRows, lang),
    ``,
    `Requisitos de salida:`,
    `• Empieza con la diferencia principal en un párrafo corto.`,
    `• Luego explica qué incluye ${leftTitle}.`,
    `• Luego explica qué incluye ${rightTitle} como grupo.`,
    `• Termina con para quién conviene cada opción.`,
  ].join("\n");
}

function buildFallbackCanonicalList(
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

  const byId = buildRowMap(rows);
  const ordered: CatalogComparisonRow[] = ids
    .map((id) => byId.get(id))
    .filter((item): item is CatalogComparisonRow => Boolean(item));

  if (ordered.length < 2) {
    return { handled: false };
  }

  const structuredSides = getStructuredSides(input);

  if (structuredSides.length === 2) {
    const [leftSide, rightSide] = structuredSides;
    const leftRows = getRowsForSide(leftSide, byId);
    const rightRows = getRowsForSide(rightSide, byId);

    if (leftRows.length > 0 && rightRows.length > 0) {
      const canonicalReply = buildGroupedComparisonCanonicalReply(
        leftSide,
        leftRows,
        rightSide,
        rightRows,
        llmLang
      );

      const comparisonItems = [...leftRows, ...rightRows].map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        minPrice: item.minPrice,
        maxPrice: item.maxPrice,
      }));

      const reply =
        (await input.answerCatalogQuestionLLM({
          idiomaDestino: llmLang,
          canonicalReply,
          userInput: input.userInput,
          mode: "grounded_catalog_sales",
          renderIntent: "catalog_compare",
          comparisonItems,
          maxIntroLines: 1,
          maxClosingLines: 1,
        })) || canonicalReply;

      return {
        handled: true,
        source: "catalog_comparison_grouped_db_llm_render" as any,
        intent: "info_servicio",
        reply,
        ctxPatch: {
          lastResolvedIntent: "compare",
        },
      };
    }
  }

  const canonicalReply = buildFallbackCanonicalList(ordered, llmLang);

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
    source: "catalog_comparison_fallback_list" as any,
    intent: "info_servicio",
    reply,
    ctxPatch: {
      lastResolvedIntent: "compare",
      comparisonCandidateServiceIds: ordered.map((item) => item.id),
    },
  };
}