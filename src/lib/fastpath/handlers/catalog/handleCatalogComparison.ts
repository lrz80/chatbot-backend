import type { Pool } from "pg";
import type { FastpathResult } from "../../runFastpath";

type HandleCatalogComparisonInput = {
  pool: Pool;
  tenantId: string;
  idiomaDestino: string;
  userInput: string;
  catalogReferenceClassification: any;
};

type CatalogComparisonRow = {
  id: string;
  name: string;
  description: string | null;
  price_base: number | string | null;
  min_price: number | string | null;
  max_price: number | string | null;
};

function toText(value: unknown): string {
  return String(value ?? "").trim();
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value: string): string {
  return toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizePoint(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPriceRange(params: {
  min: number | null;
  max: number | null;
  idiomaDestino: string;
}): string {
  const { min, max, idiomaDestino } = params;

  if (min == null && max == null) {
    return idiomaDestino === "en"
      ? "price_not_available"
      : "precio_no_disponible";
  }

  if (min != null && max != null) {
    if (min === max) return `$${min.toFixed(2)}`;

    return idiomaDestino === "en"
      ? `from $${min.toFixed(2)}`
      : `desde $${min.toFixed(2)}`;
  }

  if (min != null) {
    return idiomaDestino === "en"
      ? `from $${min.toFixed(2)}`
      : `desde $${min.toFixed(2)}`;
  }

  return idiomaDestino === "en"
    ? `up to $${max!.toFixed(2)}`
    : `hasta $${max!.toFixed(2)}`;
}

function splitDescriptionIntoPoints(description: string): string[] {
  const raw = toText(description);
  if (!raw) return [];

  return raw
    .split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function buildSharedPointSet(rows: CatalogComparisonRow[]): Set<string> {
  const pointSets = rows.map((row) => {
    const normalizedPoints = splitDescriptionIntoPoints(toText(row.description))
      .map(normalizePoint)
      .filter(Boolean);

    return new Set(normalizedPoints);
  });

  if (!pointSets.length) return new Set<string>();

  const first = [...pointSets[0]];
  return new Set(
    first.filter((point) => pointSets.every((set) => set.has(point)))
  );
}

function getUniquePointsForRow(
  row: CatalogComparisonRow,
  sharedPoints: Set<string>
): string[] {
  const originalPoints = splitDescriptionIntoPoints(toText(row.description));

  const seen = new Set<string>();
  const unique: string[] = [];

  for (const point of originalPoints) {
    const normalized = normalizePoint(point);
    if (!normalized) continue;
    if (sharedPoints.has(normalized)) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    unique.push(point);
  }

  return unique.slice(0, 3);
}

function buildComparisonCanonicalReply(params: {
  rows: CatalogComparisonRow[];
  idiomaDestino: string;
}): string {
  const { rows, idiomaDestino } = params;

  const sharedPoints = buildSharedPointSet(rows);

  const normalizedRows = rows.map((row) => {
    const min = toNumber(row.min_price);
    const max = toNumber(row.max_price);

    return {
      id: toText(row.id),
      name: toText(row.name),
      min,
      max,
      priceText: formatPriceRange({ min, max, idiomaDestino }),
      uniquePoints: getUniquePointsForRow(row, sharedPoints),
    };
  });

  const rowsWithMin = normalizedRows.filter(
    (row): row is typeof row & { min: number } => row.min != null
  );

  let cheapestId: string | null = null;
  let mostExpensiveId: string | null = null;
  let priceGapText: string | null = null;

  if (rowsWithMin.length >= 2) {
    const cheapest = [...rowsWithMin].sort((a, b) => a.min - b.min)[0];
    const mostExpensive = [...rowsWithMin].sort((a, b) => b.min - a.min)[0];

    if (cheapest.id !== mostExpensive.id && mostExpensive.min > cheapest.min) {
      cheapestId = cheapest.id;
      mostExpensiveId = mostExpensive.id;
      priceGapText = `$${(mostExpensive.min - cheapest.min).toFixed(2)}`;
    }
  }

  const lines: string[] = [];

  lines.push("COMPARISON_MODE: catalog_compare");
  lines.push(`ITEM_COUNT: ${normalizedRows.length}`);

  if (mostExpensiveId && cheapestId && priceGapText) {
    lines.push(`PRICE_GAP: ${priceGapText}`);
    lines.push(`PRICE_LOWEST_ID: ${cheapestId}`);
    lines.push(`PRICE_HIGHEST_ID: ${mostExpensiveId}`);
  }

  if (sharedPoints.size > 0) {
    const sharedOriginal = splitDescriptionIntoPoints(
      rows.map((row) => toText(row.description)).join("\n")
    ).filter((point) => sharedPoints.has(normalizePoint(point)));

    const dedupShared: string[] = [];
    const seen = new Set<string>();

    for (const point of sharedOriginal) {
      const normalized = normalizePoint(point);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      dedupShared.push(point);
    }

    for (const point of dedupShared.slice(0, 3)) {
      lines.push(`COMMON: ${point}`);
    }
  }

  for (const row of normalizedRows) {
    lines.push(`ITEM: ${row.name}`);
    lines.push(`ITEM_ID: ${row.id}`);
    lines.push(`PRICE: ${row.priceText}`);

    for (const point of row.uniquePoints) {
      lines.push(`DIFF: ${point}`);
    }
  }

  return lines.join("\n").trim();
}

export async function handleCatalogComparison(
  input: HandleCatalogComparisonInput
): Promise<FastpathResult> {
  const ids = Array.isArray(input.catalogReferenceClassification?.targetServiceIds)
    ? input.catalogReferenceClassification.targetServiceIds.slice(0, 6)
    : [];

  if (ids.length < 2) {
    return { handled: false };
  }

  const { rows } = await input.pool.query<CatalogComparisonRow>(
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

  const byId = new Map<string, CatalogComparisonRow>(
    rows.map((row: CatalogComparisonRow) => [String(row.id), row])
    );

    const ordered = ids
    .map((id: string): CatalogComparisonRow | undefined => byId.get(String(id)))
    .filter(
        (row: CatalogComparisonRow | undefined): row is CatalogComparisonRow =>
        Boolean(row)
    );

  if (ordered.length < 2) {
    return { handled: false };
  }

  const canonicalReply = buildComparisonCanonicalReply({
    rows: ordered,
    idiomaDestino: input.idiomaDestino,
  });

  return {
    handled: true,
    source: "catalog_comparison_db" as any,
    intent: "info_servicio",
    reply: canonicalReply,
    ctxPatch: {
      lastResolvedIntent: "compare",
      last_catalog_at: Date.now(),
    } as any,
  };
}