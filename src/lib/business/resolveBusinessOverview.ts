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

function buildServiceSearchCorpus(row: ServiceRow): string {
  return normalizeText(
    [
      row.name,
      row.category,
      row.tipo,
      row.description,
    ]
      .filter(Boolean)
      .join(" | ")
  );
}

function infoClaveMentionsService(infoClaveNorm: string, row: ServiceRow): boolean {
  const candidates = uniqueStrings([
    row.name,
    row.category,
    row.tipo,
  ])
    .map(normalizeText)
    .filter(Boolean);

  if (candidates.length === 0) return false;

  return candidates.some((candidate) => infoClaveNorm.includes(candidate));
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

  const matchedRows = rows.filter((row) => {
    if (!row?.id || !row?.name) return false;

    // match principal: el servicio/familia aparece de forma natural en info_clave
    if (infoClaveMentionsService(infoClaveNorm, row)) {
      return true;
    }

    // fallback semántico ligero: si el corpus del servicio aparece en info_clave
    const corpus = buildServiceSearchCorpus(row);
    if (!corpus) return false;

    const keyParts = corpus
      .split("|")
      .map((x) => normalizeText(x))
      .filter(Boolean);

    return keyParts.some((part) => part.length >= 4 && infoClaveNorm.includes(part));
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