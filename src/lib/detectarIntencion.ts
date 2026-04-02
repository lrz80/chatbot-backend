// src/lib/detectarIntencion.ts
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

export type Intento = {
  intencion: string;
  nivel_interes: number;

  // compatibilidad con callers viejos
  intent: string;
  nivel: number;

  // nuevo contrato estructurado
  facets: IntentFacets;
  scope: IntentScope;
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
  facets?: {
    asksPrices?: unknown;
    asksSchedules?: unknown;
    asksLocation?: unknown;
    asksAvailability?: unknown;
  } | null;
};

const UNIVERSAL_INTENTS = [
  "saludo",
  "precio",
  "horario",
  "ubicacion",
  "disponibilidad",
  "agendar",
  "clase_prueba",
  "pago",
  "cancelar",
  "soporte",
  "queja",
  "info_general",
  "info_servicio",
  "no_interesado",
  "duda",
  "soporte_reserva",
] as const;

const SALES_INTENTS = new Set<string>([
  "precio",
  "agendar",
  "pago",
  "disponibilidad",
  "clase_prueba",
]);

function makeIntent(
  intencion: string,
  nivel_interes: number,
  facets: IntentFacets = {},
  scope: IntentScope = "none"
): Intento {
  const cleanIntent = String(intencion || "duda").trim().toLowerCase();
  const cleanNivelRaw = Number(nivel_interes);
  const cleanNivel = Number.isFinite(cleanNivelRaw)
    ? Math.max(1, Math.min(3, cleanNivelRaw))
    : 1;

  return {
    intencion: cleanIntent,
    nivel_interes: cleanNivel,
    intent: cleanIntent,
    nivel: cleanNivel,
    facets: {
      asksPrices: Boolean(facets.asksPrices),
      asksSchedules: Boolean(facets.asksSchedules),
      asksLocation: Boolean(facets.asksLocation),
      asksAvailability: Boolean(facets.asksAvailability),
    },
    scope,
  };
}

function canalesDe(canal?: string): string[] {
  const c = String(canal || "whatsapp").trim().toLowerCase();
  return c === "meta" ? ["meta", "facebook", "instagram"] : [c];
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

function sanitizeLlmOutput(parsed: LlmIntentOutput | null | undefined): Intento | null {
  if (!parsed || typeof parsed !== "object") return null;

  const rawIntent = String(parsed.intencion || "").trim().toLowerCase();
  if (!rawIntent) return null;

  const normalizedIntent =
    rawIntent === "servicios_generales" ||
    rawIntent === "overview_servicios" ||
    rawIntent === "business_overview"
      ? "info_general"
      : rawIntent;

  const nivelRaw = Number(parsed.nivel_interes ?? 1);
  const scope = normalizeIntentScope(parsed.scope);

  const facets: IntentFacets = {
    asksPrices: Boolean(parsed.facets?.asksPrices),
    asksSchedules: Boolean(parsed.facets?.asksSchedules),
    asksLocation: Boolean(parsed.facets?.asksLocation),
    asksAvailability: Boolean(parsed.facets?.asksAvailability),
  };

  const hasAnyFacet =
    facets.asksPrices ||
    facets.asksSchedules ||
    facets.asksLocation ||
    facets.asksAvailability;

  if (normalizedIntent === "duda" && hasAnyFacet) {
    return makeIntent("info_general", Math.max(2, nivelRaw || 1), facets, scope);
  }

  if (normalizedIntent === "info_servicio" && scope === "general") {
    return makeIntent("info_general", nivelRaw, facets, "general");
  }

  return makeIntent(normalizedIntent, nivelRaw, facets, scope);
}

function buildUniversalIntentGuide(): string {
  return [
    `- saludo: saludo puro o apertura conversacional sin pedido claro`,
    `- precio: pregunta enfocada en precios, costos, tarifas o cotización`,
    `- horario: pregunta enfocada en horarios u horas de atención`,
    `- ubicacion: pregunta enfocada en dirección o ubicación`,
    `- disponibilidad: pregunta enfocada en disponibilidad, cupos, fechas o stock`,
    `- agendar: intención de reservar, agendar, bookear o concretar cita`,
    `- clase_prueba: intención de clase de prueba, sesión introductoria o trial`,
    `- pago: intención de pagar, activar, suscribirse o completar checkout`,
    `- cancelar: intención de cancelar algo no relacionado a soporte de reserva`,
    `- soporte: ayuda, problema técnico u operativo`,
    `- queja: molestia, reclamo o insatisfacción`,
    `- info_general: overview general del negocio, servicios principales, qué ofrecen, qué hacen o varias dudas generales sin una entidad concreta`,
    `- info_servicio: pregunta sobre un servicio, plan, paquete, producto, variante u oferta concreta ya identificable o claramente mencionada`,
    `- no_interesado: rechazo claro o desinterés`,
    `- duda: mensaje ambiguo o insuficiente`,
    `- soporte_reserva: cambio, cancelación o problema relacionado con una reserva/cita ya existente`,
  ].join("\n");
}

async function loadTenantContext(tenantId: string, canal: Canal): Promise<string> {
  let tenantInfo = `Canal: ${canal}`;

  try {
    const res = await pool.query(
      `
      SELECT
        name AS nombre,
        categoria,
        funciones_asistente,
        info_clave
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
        `Información clave: ${String(t.info_clave || "").trim()}`,
        `Canal: ${String(canal || "").trim()}`,
      ]
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
      const respuesta = String(row.respuesta || "").trim();

      const parts = [`- ${nombre}`];

      if (ejemplos.length) {
        parts.push(`ejemplos: ${ejemplos.join(" | ")}`);
      }

      if (respuesta) {
        parts.push(`respuesta_referencial: ${respuesta}`);
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
  tenantIntents: TenantIntentRow[];
}): Promise<Intento | null> {
  const tenantIntentGuide = buildTenantIntentGuide(input.tenantIntents);
  const universalIntentGuide = buildUniversalIntentGuide();

  const prompt = `
Eres un clasificador de intención para una plataforma SaaS multitenant.

Tu trabajo es devolver una sola intención principal y facets estructuradas.
No uses respuestas narrativas.
No inventes nuevos campos.
No devuelvas texto extra fuera del JSON.

Mensaje del cliente:
"""${input.mensaje}"""

Contexto del negocio:
${input.tenantInfo}

Intenciones universales permitidas:
${UNIVERSAL_INTENTS.map((i) => `- ${i}`).join("\n")}

Definición de intenciones universales:
${universalIntentGuide}

Intenciones específicas configuradas por el tenant:
${tenantIntentGuide}

Reglas:
- Debes elegir UNA intención principal.
- Además de la intención principal, debes devolver un campo estructurado "scope" con uno de estos valores:
  - "general": consulta general del negocio o del producto sin entidad concreta
  - "entity": consulta sobre un servicio, plan, producto o entidad concreta
  - "family": consulta sobre una familia o categoría de servicios
  - "variant": consulta sobre una modalidad o variante concreta
  - "none": no aplica o no está claro
- "info_servicio" solo es válido cuando el scope sea "entity", "family" o "variant".
- Si la consulta es general y exploratoria, usa "info_general" con scope "general".
- Puedes elegir una intención universal o una intención específica del tenant si es claramente mejor.
- Si el mensaje combina varias cosas, conserva una intención principal razonable y usa facets para lo demás.
- No uses intents compuestos.
- No conviertas la combinación de varios temas en un nombre de intent nuevo.
- Usa "info_general" cuando el cliente pida una vista general del negocio o de los servicios principales sin mencionar una entidad concreta.
- Usa "info_servicio" solo cuando el cliente pregunte por un servicio, plan, paquete, producto o variante concreta, o por el detalle de una entidad identificable.
- Si el cliente pregunta "qué ofrecen", "qué servicios tienen" o pide una vista general, eso normalmente es "info_general", no "info_servicio".
- Si el cliente pregunta "qué incluye X", "qué trae X", "cómo funciona X" o pide detalle de un plan o servicio concreto, eso normalmente es "info_servicio".
- Usa facets independientes:
  - asksPrices
  - asksSchedules
  - asksLocation
  - asksAvailability
- Puede haber varios facets en true al mismo tiempo.
- Si el mensaje es ambiguo y no alcanza para clasificar con confianza, usa "duda".
- nivel_interes:
  - 1 = curiosidad vaga, saludo, rechazo o duda general
  - 2 = pide información para evaluar
  - 3 = quiere avanzar, reservar, pagar o concretar

Devuelve SOLO JSON con esta forma exacta:
{
  "intencion": "string",
  "nivel_interes": 1,
  "scope": "general",
  "facets": {
    "asksPrices": false,
    "asksSchedules": false,
    "asksLocation": false,
    "asksAvailability": false
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
    return sanitizeLlmOutput(parsedObj);
  } catch (error) {
    console.error("❌ Error clasificando intención con modelo:", error);
    return null;
  }
}

export function esIntencionDeVenta(intencion: string): boolean {
  const value = String(intencion || "").trim().toLowerCase();

  if (!value) return false;
  if (value === "soporte" || value === "queja" || value === "cancelar" || value === "soporte_reserva") {
    return false;
  }

  return SALES_INTENTS.has(value) || value.includes("comprar");
}

export async function detectarIntencion(
  mensaje: string,
  tenantId: string,
  canal: Canal = "whatsapp"
): Promise<Intento> {
  const original = String(mensaje || "").trim();

  if (!original) {
    return makeIntent("duda", 1);
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
  });

  const [tenantInfo, tenantIntents] = await Promise.all([
    loadTenantContext(tenantId, canal),
    loadTenantIntents(tenantId, canal),
  ]);

  const classified = await classifyIntentWithModel({
    openai,
    mensaje: original,
    tenantInfo,
    tenantIntents,
  });

  if (classified) {
    return classified;
  }

  return makeIntent("duda", 1);
}