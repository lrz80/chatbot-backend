import type { Pool } from "pg";

type ResolveBusinessOverviewInput = {
  pool: Pool;
  tenantId: string;
  infoClave: string;
};

export type BusinessOverviewResolution = {
  source: "info_clave";
  kind: "service_overview";
  presentedEntityIds: string[];
  presentedFamilyKeys: string[];
  presentedEntityNames: string[];
};

type ServiceRow = {
  id: string;
  name: string | null;
  category: string | null;
  tipo: string | null;
  description: string | null;
};

function normalizeText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4);
}

function overlapScore(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));

  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let hits = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) hits++;
  }

  return hits;
}

export async function resolveBusinessOverview(
  input: ResolveBusinessOverviewInput
): Promise<BusinessOverviewResolution> {
  const { pool, tenantId, infoClave } = input;

  const { rows } = await pool.query<ServiceRow>(
    `
    SELECT
      s.id,
      s.name,
      s.category,
      s.tipo,
      s.description
    FROM services s
    WHERE s.tenant_id = $1
      AND s.active = true
      AND s.name IS NOT NULL
    ORDER BY s.created_at ASC
    `,
    [tenantId]
  );

  const infoClaveNorm = normalizeText(infoClave);

  const familyCandidates = uniqueStrings(
    rows.flatMap((row) => [
      row.category || "",
      row.tipo || "",
    ])
  );

  const matchedFamilyKeys = familyCandidates.filter((family) => {
    const familyNorm = normalizeText(family);
    if (!familyNorm) return false;

    if (infoClaveNorm.includes(familyNorm)) return true;

    return overlapScore(infoClaveNorm, familyNorm) >= 1;
  });

  const matchedRows = rows.filter((row) => {
    const familyValues = [row.category || "", row.tipo || ""].filter(Boolean);

    const familyMatch = familyValues.some((family) =>
      matchedFamilyKeys.includes(String(family).trim())
    );

    if (familyMatch) return true;

    const serviceCorpus = [
      row.name || "",
      row.description || "",
    ].join(" | ");

    return overlapScore(infoClaveNorm, serviceCorpus) >= 2;
  });

  const presentedEntityIds = uniqueStrings(
    matchedRows.map((row) => row.id)
  );

  const presentedEntityNames = uniqueStrings(
    matchedRows.map((row) => row.name || "")
  );

  const presentedFamilyKeys = uniqueStrings(
    matchedRows.flatMap((row) => [
      row.category || "",
      row.tipo || "",
    ])
  ).map((value) => normalizeText(value));

  return {
    source: "info_clave",
    kind: "service_overview",
    presentedEntityIds,
    presentedFamilyKeys,
    presentedEntityNames,
  };
}