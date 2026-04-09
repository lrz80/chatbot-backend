import OpenAI from "openai";
import pool from "./db";
import type { Canal } from "./types/canal";

export type { Canal };

export type IntentFacets = {
  asksPrices?: boolean;
  asksSchedules?: boolean;
  asksLocation?: boolean;
  asksAvailability?: boolean;
};

export type IntentScope =
  | "general"
  | "entity"
  | "family"
  | "variant"
  | "none";

export type PurchaseIntentLevel = "unknown" | "low" | "medium" | "high";
export type CommercialUrgencyLevel = "unknown" | "low" | "medium" | "high";

export type CommercialSignal = {
  purchaseIntent: PurchaseIntentLevel;
  wantsBooking: boolean;
  wantsQuote: boolean;
  wantsHuman: boolean;
  urgency: CommercialUrgencyLevel;
};

export type IntentRoutingHints = {
  catalogScope: "none" | "overview" | "targeted";
  businessInfoScope: "none" | "overview" | "facet";
};

export type IntentSource = "llm" | "fallback";

export type Intento = {
  intencion: string;
  nivel_interes: number;

  // compatibilidad legacy
  intent: string;
  nivel: number;

  // contrato estructurado
  facets: IntentFacets;
  scope: IntentScope;
  commercial: CommercialSignal;
  routingHints: IntentRoutingHints;

  // metadatos no disruptivos
  source?: IntentSource;
  confidence?: number;
};

type TenantIntentRow = {
  nombre: string;
  ejemplos?: string[] | string | null;
  respuesta?: string | null;
  canal?: string | null;
  idioma?: string | null;
  prioridad?: number | null;
  activo?: boolean | null;
};

type LlmIntentOutput = {
  intencion?: unknown;
  nivel_interes?: unknown;
  scope?: unknown;
  confidence?: unknown;
  facets?: {
    asksPrices?: unknown;
    asksSchedules?: unknown;
    asksLocation?: unknown;
    asksAvailability?: unknown;
  } | null;
  commercial?: {
    purchaseIntent?: unknown;
    wantsBooking?: unknown;
    wantsQuote?: unknown;
    wantsHuman?: unknown;
    urgency?: unknown;
  } | null;
};

export type IntentDefinition = {
  key: string;
  description?: string | null;
  examples?: string[];
  source: "system" | "tenant";
};

type DetectIntentCatalog = {
  intents: IntentDefinition[];
};

function normalizeIntentKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function dedupeIntentDefinitions(items: IntentDefinition[]): IntentDefinition[] {
  const map = new Map<string, IntentDefinition>();

  for (const item of items) {
    const key = normalizeIntentKey(item.key);
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        key,
        description: String(item.description || "").trim() || null,
        examples: Array.isArray(item.examples)
          ? item.examples.map((x) => String(x || "").trim()).filter(Boolean)
          : [],
        source: item.source,
      });
      continue;
    }

    const prev = map.get(key)!;
    map.set(key, {
      key,
      description:
        prev.description || String(item.description || "").trim() || null,
      examples: Array.from(
        new Set([
          ...(prev.examples || []),
          ...((item.examples || []).map((x) => String(x || "").trim()).filter(Boolean)),
        ])
      ),
      source: prev.source === "system" ? "system" : item.source,
    });
  }

  return Array.from(map.values());
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function makeDefaultCommercialSignal(): CommercialSignal {
  return {
    purchaseIntent: "unknown",
    wantsBooking: false,
    wantsQuote: false,
    wantsHuman: false,
    urgency: "unknown",
  };
}

function clampLegacyLevel(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  if (numeric < 1) return 1;
  if (numeric > 3) return 3;
  return Math.trunc(numeric);
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeConfidence(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function normalizePurchaseIntentLevel(value: unknown): PurchaseIntentLevel {
  const normalized = String(value || "").trim().toLowerCase();

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function normalizeUrgencyLevel(value: unknown): CommercialUrgencyLevel {
  const normalized = String(value || "").trim().toLowerCase();

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function normalizeCommercialSignal(
  input?: LlmIntentOutput["commercial"] | null
): CommercialSignal {
  if (!input || typeof input !== "object") {
    return makeDefaultCommercialSignal();
  }

  return {
    purchaseIntent: normalizePurchaseIntentLevel(input.purchaseIntent),
    wantsBooking: normalizeBoolean(input.wantsBooking),
    wantsQuote: normalizeBoolean(input.wantsQuote),
    wantsHuman: normalizeBoolean(input.wantsHuman),
    urgency: normalizeUrgencyLevel(input.urgency),
  };
}

function deriveLegacyInterestLevelFromCommercial(
  purchaseIntent: PurchaseIntentLevel,
  urgency: CommercialUrgencyLevel,
  explicitNivel?: unknown
): number {
  const explicit = Number(explicitNivel);
  if (Number.isFinite(explicit)) {
    return clampLegacyLevel(explicit);
  }

  if (purchaseIntent === "high" || urgency === "high") return 3;
  if (purchaseIntent === "medium" || urgency === "medium") return 2;
  if (purchaseIntent === "low") return 1;

  return 1;
}

function makeIntent(
  intencion: string,
  nivel_interes: number,
  facets: IntentFacets = {},
  scope: IntentScope = "none",
  commercial: CommercialSignal = makeDefaultCommercialSignal(),
  meta?: {
    source?: IntentSource;
    confidence?: number;
  }
): Intento {
  const cleanIntent = String(intencion || "duda").trim().toLowerCase() || "duda";
  const cleanNivel = clampLegacyLevel(nivel_interes);

  const normalizedFacets: IntentFacets = {
    asksPrices: Boolean(facets.asksPrices),
    asksSchedules: Boolean(facets.asksSchedules),
    asksLocation: Boolean(facets.asksLocation),
    asksAvailability: Boolean(facets.asksAvailability),
  };

  return {
    intencion: cleanIntent,
    nivel_interes: cleanNivel,
    intent: cleanIntent,
    nivel: cleanNivel,
    facets: normalizedFacets,
    scope,
    commercial,
    routingHints: buildIntentRoutingHints({
      intent: cleanIntent,
      scope,
      facets: normalizedFacets,
    }),
    source: meta?.source,
    confidence: meta?.confidence,
  };
}

function canalesDe(canal?: string): string[] {
  const c = String(canal || "").trim().toLowerCase();

  if (!c) return [];

  if (c === "meta") {
    return ["meta", "facebook", "instagram"];
  }

  if (c === "facebook" || c === "instagram") {
    return ["meta", c];
  }

  return [c];
}

function normalizeExamples(value: TenantIntentRow["ejemplos"]): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  return [];
}

function buildAllowedIntentCatalog(args: {
  systemIntents: IntentDefinition[];
  tenantIntents: TenantIntentRow[];
}): DetectIntentCatalog {
  const tenantIntentDefs = args.tenantIntents.reduce<IntentDefinition[]>(
    (acc, row) => {
      const key = normalizeIntentKey(row.nombre);
      if (!key) return acc;

      acc.push({
        key,
        description: null,
        examples: normalizeExamples(row.ejemplos),
        source: "tenant",
      });

      return acc;
    },
    []
  );

  return {
    intents: dedupeIntentDefinitions([
      ...(args.systemIntents || []),
      ...tenantIntentDefs,
    ]),
  };
}

function safeJsonParseObject(raw: string): Record<string, unknown> | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // seguimos abajo
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);

    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeIntentScope(value: unknown): IntentScope {
  const scope = String(value || "").trim().toLowerCase();

  if (
    scope === "general" ||
    scope === "entity" ||
    scope === "family" ||
    scope === "variant"
  ) {
    return scope;
  }

  return "none";
}

function buildIntentRoutingHints(args: {
  intent: string;
  scope: IntentScope;
  facets: IntentFacets;
}): IntentRoutingHints {
  const intent = String(args.intent || "").trim().toLowerCase();
  const scope = args.scope;

  const asksPrices = args.facets.asksPrices === true;
  const asksSchedules = args.facets.asksSchedules === true;
  const asksLocation = args.facets.asksLocation === true;
  const asksAvailability = args.facets.asksAvailability === true;

  const hasBusinessInfoFacet =
    asksSchedules || asksLocation || asksAvailability;

  const isCatalogTargetedScope =
    scope === "entity" || scope === "family" || scope === "variant";

  const isCatalogOverviewIntent =
    intent === "precio" ||
    intent === "info_servicio" ||
    intent === "info_general";

  const catalogScope: IntentRoutingHints["catalogScope"] =
    isCatalogTargetedScope
      ? "targeted"
      : asksPrices || isCatalogOverviewIntent
      ? "overview"
      : "none";

  const businessInfoScope: IntentRoutingHints["businessInfoScope"] =
    scope === "general" && hasBusinessInfoFacet
      ? "facet"
      : scope === "general" && intent === "info_general"
      ? "overview"
      : "none";

  return {
    catalogScope,
    businessInfoScope,
  };
}

function normalizeCanonicalIntentName(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) return "";

  if (
    raw === "servicios_generales" ||
    raw === "overview_servicios" ||
    raw === "business_overview"
  ) {
    return "info_general";
  }

  return raw;
}

function isAllowedIntent(
  normalizedIntent: string,
  catalog: DetectIntentCatalog
): boolean {
  if (!normalizedIntent) return false;

  return catalog.intents.some((item) => item.key === normalizedIntent);
}

function sanitizeLlmOutput(
  parsed: LlmIntentOutput | null | undefined,
  catalog: DetectIntentCatalog
): Intento | null {
  if (!parsed || typeof parsed !== "object") return null;

  const normalizedIntent = normalizeCanonicalIntentName(parsed.intencion);
  if (!normalizedIntent) return null;

  if (!isAllowedIntent(normalizedIntent, catalog)) {
    return null;
  }

  const scope = normalizeIntentScope(parsed.scope);

  const facets: IntentFacets = {
    asksPrices: normalizeBoolean(parsed.facets?.asksPrices),
    asksSchedules: normalizeBoolean(parsed.facets?.asksSchedules),
    asksLocation: normalizeBoolean(parsed.facets?.asksLocation),
    asksAvailability: normalizeBoolean(parsed.facets?.asksAvailability),
  };

  const commercial = normalizeCommercialSignal(parsed.commercial);

  const nivel = deriveLegacyInterestLevelFromCommercial(
    commercial.purchaseIntent,
    commercial.urgency,
    parsed.nivel_interes
  );

  return makeIntent(normalizedIntent, nivel, facets, scope, commercial, {
    source: "llm",
    confidence: normalizeConfidence(parsed.confidence),
  });
}

function buildIntentGuide(catalog: DetectIntentCatalog): string {
  if (!catalog.intents.length) return "- (ninguna)";

  return catalog.intents
    .map((item) => {
      const parts = [`- ${item.key}`];

      const description = String(item.description || "").trim();
      if (description) {
        parts.push(`descripcion: ${description}`);
      }

      if (Array.isArray(item.examples) && item.examples.length) {
        parts.push(`ejemplos: ${item.examples.join(" | ")}`);
      }

      parts.push(`source: ${item.source}`);

      return parts.join(" | ");
    })
    .join("\n");
}

async function loadTenantContext(tenantId: string, canal: Canal): Promise<string> {
  let tenantInfo = `Canal: ${String(canal || "").trim()}`;

  try {
    const res = await pool.query(
      `
      SELECT
        name AS nombre,
        categoria,
        funciones_asistente
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    if (res.rows?.length) {
      const t = res.rows[0];

      tenantInfo = [
        `Negocio: ${String(t.nombre || "").trim()}`,
        `Categoría: ${String(t.categoria || "").trim()}`,
        `Funciones del asistente: ${String(t.funciones_asistente || "").trim()}`,
        `Canal: ${String(canal || "").trim()}`,
      ]
        .map((item) => item.trim())
        .filter(Boolean)
        .join("\n");
    }
  } catch (error) {
    console.error("❌ Error cargando tenant context:", error);
  }

  return tenantInfo;
}

async function loadTenantIntents(
  tenantId: string,
  canal: Canal
): Promise<TenantIntentRow[]> {
  const canales = canalesDe(canal);

  if (!canales.length) {
    return [];
  }

  const { rows } = await pool.query(
    `
    SELECT nombre, ejemplos, respuesta, canal, idioma, prioridad, activo
    FROM intenciones
    WHERE tenant_id = $1
      AND canal = ANY($2)
      AND (activo IS NULL OR activo = TRUE)
    ORDER BY COALESCE(prioridad, 0) ASC, id ASC
    LIMIT 100
    `,
    [tenantId, canales]
  );

  return (rows || []) as TenantIntentRow[];
}

function buildTenantIntentGuide(rows: TenantIntentRow[]): string {
  if (!rows.length) return "- (ninguna)";

  return rows
    .map((row) => {
      const nombre = String(row.nombre || "").trim().toLowerCase();
      const ejemplos = normalizeExamples(row.ejemplos);

      if (!nombre) return "";

      const parts = [`- ${nombre}`];

      if (ejemplos.length) {
        parts.push(`ejemplos: ${ejemplos.join(" | ")}`);
      }

      return parts.join(" | ");
    })
    .filter(Boolean)
    .join("\n");
}

async function classifyIntentWithModel(input: {
  openai: OpenAI;
  mensaje: string;
  tenantInfo: string;
  allowedIntentCatalog: DetectIntentCatalog;
}): Promise<Intento | null> {
  const allowedIntentGuide = buildIntentGuide(input.allowedIntentCatalog);

  const prompt = `
Eres un clasificador de intención para una plataforma SaaS multitenant.

Tu trabajo es clasificar el mensaje del usuario.
No eres el motor de catálogo.
No eres el resolutor final del negocio.
No inventes intents nuevos.
No devuelvas texto fuera del JSON.

Mensaje del cliente:
"""${input.mensaje}"""

Contexto operativo del tenant:
${input.tenantInfo}

Intenciones permitidas:
${allowedIntentGuide}

Reglas:
- Debes elegir UNA intención principal.
- La intención elegida debe salir exclusivamente de la lista "Intenciones permitidas".
- No inventes un nombre nuevo de intención.
- "scope" debe ser uno de:
  - "general"
  - "entity"
  - "family"
  - "variant"
  - "none"
- Usa facets independientes:
  - asksPrices
  - asksSchedules
  - asksLocation
  - asksAvailability
- Puede haber varios facets en true al mismo tiempo.
- Si el mensaje es ambiguo, devuelve la intención ambigua permitida por el catálogo.
- Señal comercial:
  - purchaseIntent: "unknown" | "low" | "medium" | "high"
  - wantsBooking
  - wantsQuote
  - wantsHuman
  - urgency: "unknown" | "low" | "medium" | "high"
- "nivel_interes" es solo compatibilidad legacy:
  - 1 = curiosidad vaga, saludo, rechazo o duda
  - 2 = está evaluando
  - 3 = quiere avanzar, reservar, pagar o concretar
- "confidence" debe ser un número entre 0 y 1.

Devuelve SOLO este JSON:
{
  "intencion": "string",
  "nivel_interes": 1,
  "scope": "general",
  "confidence": 0.0,
  "facets": {
    "asksPrices": false,
    "asksSchedules": false,
    "asksLocation": false,
    "asksAvailability": false
  },
  "commercial": {
    "purchaseIntent": "unknown",
    "wantsBooking": false,
    "wantsQuote": false,
    "wantsHuman": false,
    "urgency": "unknown"
  }
}
  `.trim();

  try {
    const completion = await input.openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = String(completion.choices[0]?.message?.content || "").trim();
    const parsedObj = safeJsonParseObject(raw) as LlmIntentOutput | null;

    return sanitizeLlmOutput(parsedObj, input.allowedIntentCatalog);
  } catch (error) {
    console.error("❌ Error clasificando intención con modelo:", error);
    return null;
  }
}

export function esIntencionDeVenta(input: {
  intent?: string | null;
  commercial?: {
    purchaseIntent?: "unknown" | "low" | "medium" | "high" | null;
    wantsBooking?: boolean | null;
    wantsQuote?: boolean | null;
  } | null;
}): boolean {
  const purchaseIntent = String(
    input.commercial?.purchaseIntent || "unknown"
  )
    .trim()
    .toLowerCase();

  return (
    purchaseIntent === "medium" ||
    purchaseIntent === "high" ||
    input.commercial?.wantsBooking === true ||
    input.commercial?.wantsQuote === true
  );
}

export async function detectarIntencion(
  mensaje: string,
  tenantId: string,
  canal: Canal,
  systemIntents: IntentDefinition[]
): Promise<Intento> {
  const original = String(mensaje || "").trim();
  const resolvedCanal = String(canal || "").trim().toLowerCase() as Canal;

  if (!original) {
    return makeIntent("duda", 1, {}, "none", makeDefaultCommercialSignal(), {
      source: "fallback",
      confidence: 0,
    });
  }

  if (!tenantId || !resolvedCanal) {
    return makeIntent("duda", 1, {}, "none", makeDefaultCommercialSignal(), {
      source: "fallback",
      confidence: 0,
    });
  }

  const [tenantInfo, tenantIntents] = await Promise.all([
    loadTenantContext(tenantId, resolvedCanal),
    loadTenantIntents(tenantId, resolvedCanal),
  ]);

  const allowedIntentCatalog = buildAllowedIntentCatalog({
    systemIntents,
    tenantIntents,
  });

  if (!allowedIntentCatalog.intents.length) {
    return makeIntent("duda", 1, {}, "none", makeDefaultCommercialSignal(), {
      source: "fallback",
      confidence: 0,
    });
  }

  const classified = await classifyIntentWithModel({
    openai,
    mensaje: original,
    tenantInfo,
    allowedIntentCatalog,
  });

  if (classified) {
    return classified;
  }

  const ambiguousIntent =
    allowedIntentCatalog.intents.find((item) => item.key === "duda")?.key ||
    allowedIntentCatalog.intents[0]?.key ||
    "duda";

  return makeIntent(
    ambiguousIntent,
    1,
    {},
    "none",
    makeDefaultCommercialSignal(),
    {
      source: "fallback",
      confidence: 0,
    }
  );
}