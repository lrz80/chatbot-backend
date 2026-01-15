// src/lib/detectarIntencion.ts
import OpenAI from "openai";
import pool from "./db";

export type Intento = { intencion: string; nivel_interes: number };
export type Canal = "whatsapp" | "facebook" | "instagram" | "meta" | "voz" | "preview";

/** ---------- Normalización ---------- */
const stripDiacritics = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const norm = (s: string) => stripDiacritics((s || "").toLowerCase().trim());

function stripLeadingGreeting(t: string) {
  const re =
    /^(hola|hello|hi|hey|buenos dias|buenas tardes|buenas noches|buen día|buenas)[\s,!.:-]*/i;
  return (t || "").replace(re, "").trim();
}

function hasWord(text: string, word: string) {
  const w = stripDiacritics((word || "").toLowerCase());
  return new RegExp(`\\b${w}\\b`, "i").test(text || "");
}

/** ---------- Intenciones universales (mínimas y generales) ---------- */
type UniversalIntent =
  | "saludo"
  | "precio"
  | "horario"
  | "ubicacion"
  | "disponibilidad" // disponibilidad / stock / cupos / disponibilidad agenda
  | "agendar" // reservar / cita / booking
  | "pago"
  | "cancelar"
  | "soporte"
  | "queja"
  | "info_servicio" // info general de lo que venden/ofrecen
  | "no_interesado"
  | "duda";

const UNIVERSAL: Array<{
  intent: UniversalIntent;
  nivel: 1 | 2 | 3;
  words?: string[];
  phrases?: string[];
}> = [
  {
    intent: "saludo",
    nivel: 1,
    words: ["hola", "hello", "hi", "hey", "saludos"],
    phrases: ["buenos dias", "buenas tardes", "buenas noches"],
  },
  {
    intent: "precio",
    nivel: 2,
    words: ["precio", "precios", "cost", "price", "tarifa", "fee", "quote", "cotizacion", "cotización"],
    phrases: ["cuanto cuesta", "how much", "cuánto vale", "me das precio", "me das una cotizacion", "me das una cotización"],
  },
  {
    intent: "horario",
    nivel: 2,
    words: ["horario", "horarios", "schedule", "hours", "abren", "cierran"],
    phrases: ["a que hora", "a qué hora", "hora de apertura", "hora de cierre", "what time", "what are your hours"],
  },
  {
    intent: "ubicacion",
    nivel: 2,
    words: ["ubicacion", "ubicación", "direccion", "dirección", "location", "address"],
    phrases: ["donde estan", "dónde están", "donde queda", "cómo llegar", "where are you", "how to get"],
  },
  {
    intent: "agendar",
    nivel: 3,
    words: ["agendar", "agenda", "cita", "turno", "appointment", "book", "reservar", "reserva", "schedule"],
    phrases: ["quiero una cita", "quiero agendar", "quiero reservar", "book an appointment", "i want to book"],
  },
  {
    intent: "disponibilidad",
    nivel: 2,
    words: ["disponibilidad", "disponible", "available", "stock", "cupo", "cupos"],
    phrases: ["tienen disponible", "hay disponibilidad", "is it available", "do you have availability"],
  },
  {
    intent: "pago",
    nivel: 3,
    words: ["pagar", "pago", "pay", "payment", "factura", "invoice", "checkout"],
    phrases: ["quiero pagar", "como pago", "cómo pago", "send me the link", "link de pago"],
  },
  {
    intent: "cancelar",
    nivel: 2,
    words: ["cancelar", "cancel", "anular"],
    phrases: ["cancela mi", "ya no quiero", "i want to cancel"],
  },
  {
    intent: "soporte",
    nivel: 2,
    words: ["problema", "error", "no funciona", "help", "ayuda", "support", "soporte"],
    phrases: ["necesito ayuda", "tengo un problema", "it doesn't work", "no me sirve"],
  },
  {
    intent: "queja",
    nivel: 2,
    words: ["queja", "reclamo", "reclamacion", "reclamación", "molesto", "enojado", "angry", "complaint"],
    phrases: ["esto es una falta", "muy mal servicio", "i'm upset", "estoy molesto"],
  },
  {
    intent: "no_interesado",
    nivel: 1,
    phrases: ["no me interesa", "no gracias", "not interested", "i am not interested"],
  },
];

/** Señales de “quiero info” genérica (sin sesgo por industria) */
const INFO_PHRASES = [
  "mas informacion",
  "más informacion",
  "quiero informacion",
  "quiero información",
  "necesito saber mas",
  "necesito saber más",
  "quiero saber mas",
  "quiero saber más",
  "quisiera saber mas",
  "quisiera saber más",
  "quiero detalles",
  "me puedes explicar",
  "en que consiste",
  "en qué consiste",
  "tell me more",
  "more info",
  "more information",
  "information please",
];

/** ---------- Venta: definición general (no por industria) ---------- */
const VENTA_SIGNAL_WORDS = [
  "comprar",
  "compra",
  "pagar",
  "pago",
  "precio",
  "precios",
  "cotizacion",
  "cotización",
  "quote",
  "checkout",
  "orden",
  "order",
  "reservar",
  "agendar",
  "cita",
  "appointment",
  "book",
  "suscripcion",
  "suscripción",
  "plan",
  "planes",
  "membership",
  "membresia",
  "membresía",
  "contratar",
  "contrato",
  "hire",
  "sign up",
  "signup",
  "join",
];

export function esIntencionDeVenta(intencion: string): boolean {
  // En un mundo ideal esto sería por “grupo”/metadata en DB.
  // Como compatibilidad, usamos un set pequeño universal.
  const s = (intencion || "").toLowerCase();
  return ["precio", "agendar", "pago", "disponibilidad"].some((k) => s.includes(k)) || s.includes("comprar");
}

/** ---------- Cargar contexto + intenciones del tenant ---------- */
type TenantIntentRow = {
  nombre: string;
  ejemplos?: string[];
  respuesta?: string;
  canal?: string | null;
  idioma?: string | null;
  prioridad?: number | null;
  activo?: boolean | null;
};

function canalesDe(canal?: string) {
  const c = (canal || "whatsapp").toLowerCase();
  return c === "meta" ? ["meta", "facebook", "instagram"] : [c];
}

async function loadTenantContext(tenantId: string, canal: Canal) {
  let tenantInfo = `Canal: ${canal}`;
  try {
    const res = await pool.query(
      `SELECT name AS nombre, categoria, funciones_asistente, info_clave
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    );
    if (res.rows?.length) {
      const t = res.rows[0];
      tenantInfo = `
Negocio: ${t.nombre || ""}
Categoría: ${t.categoria || ""}
Funciones del asistente: ${t.funciones_asistente || ""}
Información clave: ${t.info_clave || ""}
Canal: ${canal}
      `.trim();
    }
  } catch (e) {
    console.error("❌ Error cargando tenant context:", e);
  }
  return tenantInfo;
}

async function loadTenantIntents(tenantId: string, canal: string) {
  const canales = canalesDe(canal);

  const { rows } = await pool.query(
    `SELECT nombre, ejemplos, respuesta, canal, idioma, prioridad, activo
     FROM intenciones
     WHERE tenant_id = $1
       AND canal = ANY($2)
       AND (activo IS NULL OR activo = TRUE)
     ORDER BY COALESCE(prioridad, 0) ASC, id ASC
     LIMIT 50`,
    [tenantId, canales]
  );

  return (rows || []) as TenantIntentRow[];
}

/** ---------- Heurísticas mínimas + fallback LLM robusto ---------- */
export async function detectarIntencion(
  mensaje: string,
  tenantId: string,
  canal: Canal = "whatsapp"
): Promise<Intento> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

  const original = (mensaje || "").trim();
  const texto = norm(original);
  const textoCore = norm(stripLeadingGreeting(original)) || texto;

  // ✅ “más info” (ES/EN) debe ganar contra "pago" si NO hay señales explícitas de checkout/pago
  const MORE_INFO_RE =
    /\b(mas\s*inf(o(rmacion)?)?|m[aá]s\s*inf(o(rmaci[oó]n)?)?|informaci[oó]n\s*adicional|more\s*info|more\s*information|more\s*details|tell\s*me\s*more)\b/i;

  if (MORE_INFO_RE.test(original)) {
    return { intencion: "info_servicio", nivel_interes: 2 };
  }

  // ✅ FAST-PATH: intención de activar/suscribirse (ES/EN) — antes de flagVenta fallbacks
  const NEG_RE = /\b(no|aun\s*no|todav[ií]a\s*no|not)\b/i;

  const SUBSCRIBE_RE =
    /\b(suscrib(ir(me)?|irse)|suscripci[oó]n|subscrib(e|ing)|subscription|sign\s*up|enroll|activar(\s+mi)?\s+(membres[ií]a|plan)|activate(\s+my)?\s+(plan|membership)|start(\s+my)?\s+(plan|membership)|quiero\s+(empezar|iniciar))\b/i;

  if (SUBSCRIBE_RE.test(original) && !NEG_RE.test(original)) {
    return { intencion: "pago", nivel_interes: 3 };
  }

  // 1) Heurísticas universales (solo lo obvio)
  // Prioridad: NO devolver saludo si hay pedido real.
  const flagInfo =
    INFO_PHRASES.some((p) => textoCore.includes(norm(p))) ||
    ["info", "informacion", "información", "information", "details", "detalle"].some((w) => hasWord(textoCore, w));

  // Venta signal general por palabras (sin hardcode a industria)
  const flagVenta = VENTA_SIGNAL_WORDS.some((w) => textoCore.includes(norm(w)));

  // Reglas universales rápidas
  for (const r of UNIVERSAL) {
    const hitWord = (r.words || []).some((w) => hasWord(textoCore, w));
    const hitPhrase = (r.phrases || []).some((p) => textoCore.includes(norm(p)));
    if (hitWord || hitPhrase) {
      // Si el clasificador cae en "saludo" pero hay info/venta, no retornes saludo
      if (r.intent === "saludo" && (flagInfo || flagVenta)) break;
      return { intencion: r.intent, nivel_interes: r.nivel };
    }
  }

  // 2) Si pide info y además hay señal de venta, prioriza algo más cercano a decisión
  if (flagVenta) {
    if (["precio", "precios", "price", "cost", "cotizacion", "cotización", "quote"]
        .some((w) => textoCore.includes(norm(w)))) {
      return { intencion: "precio", nivel_interes: 2 };
    }

    if (["agendar", "reservar", "appointment", "book", "cita"]
        .some((w) => textoCore.includes(norm(w)))) {
      return { intencion: "agendar", nivel_interes: 3 };
    }

    // ✅ Pago: SOLO si hay señal explícita (pagar/checkout/link/stripe/paid/suscripción)
    const pagoExplicitRe =
      /\b(pagar|pago|payment|checkout|stripe|buy|paid|i\s*paid|ya\s*pague|link\s+de\s+pago|enlace\s+de\s+pago|suscrib(ir(me)?|irse)|suscripci[oó]n|subscrib(e|ing)|subscription|sign\s*up)\b/i;

    if (pagoExplicitRe.test(original)) {
      return { intencion: "pago", nivel_interes: 3 };
    }

    // si hay señal de compra genérica pero nada explícito, mejor info_servicio con interés alto
    return { intencion: "info_servicio", nivel_interes: 3 };
  }

  // 3) Si solo pide info genérica: info_servicio con interés medio
  if (flagInfo) return { intencion: "info_servicio", nivel_interes: 2 };

  // 4) Fallback LLM con intenciones dinámicas por tenant
  const [tenantInfo, tenantIntents] = await Promise.all([
    loadTenantContext(tenantId, canal),
    loadTenantIntents(tenantId, canal),
  ]);

  const universalList = [
    "saludo",
    "precio",
    "horario",
    "ubicacion",
    "disponibilidad",
    "agendar",
    "pago",
    "cancelar",
    "soporte",
    "queja",
    "info_servicio",
    "no_interesado",
    "duda",
  ];

  const tenantList = tenantIntents
    .map(i => ({
      intent: norm(i.nombre),
      ejemplos: Array.isArray(i.ejemplos) ? i.ejemplos.join(" | ") : (i.ejemplos || "")
    }))
    .filter(x => x.intent);

  const prompt = `
Eres un clasificador de intención de mensajes de clientes para cualquier tipo de negocio (multitenant).
Debes elegir UNA intención.

Contexto del negocio:
${tenantInfo}

Mensaje del cliente:
"${original}"

Intenciones universales:
${universalList.map((x) => `- ${x}`).join("\n")}

Intenciones específicas del negocio (si aplican):
${tenantList.length ? tenantList.map((x) => `- ${x.intent} (ejemplos: ${x.ejemplos || "N/A"})`).join("\n") : "- (ninguna)"}

Reglas:
- Si hay saludo + pedido real, NO devuelvas "saludo".
- "info_servicio" es para preguntas generales tipo: qué ofrecen, cómo funciona, detalles, catálogo, etc.
- "agendar" es para citas/reservas/booking/visita.
- "disponibilidad" es para stock/cupos/disponibilidad de fechas sin confirmar cita.
- Si el usuario dice "quiero suscribirme / suscripción / activar membresía / sign up / subscribe", clasifica como "pago" con nivel_interes 3.
- Devuelve también nivel_interes (1 bajo, 2 medio, 3 alto) basado en cercanía a compra:
  3: quiere agendar, pagar, comprar, link, cotización directa.
  2: pregunta precio, disponibilidad, detalles para decidir.
  1: saludo, curiosidad vaga, duda general sin señales.

Salida: SOLO JSON sin texto extra:
{"intencion":"...","nivel_interes":1|2|3}
  `.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    });

    const raw = (completion.choices[0]?.message?.content || "{}").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw) as Intento;

    if (parsed?.intencion) {
      const intencion = String(parsed.intencion || "").toLowerCase().trim();

      // Backstop: nunca regreses saludo si hay señales claras
      if (intencion === "saludo" && (flagInfo || flagVenta)) {
        return { intencion: flagVenta ? "info_servicio" : "info_servicio", nivel_interes: Math.max(2, parsed.nivel_interes || 2) };
      }

      return {
        intencion,
        nivel_interes: Math.min(3, Math.max(1, Number(parsed.nivel_interes) || 1)),
      };
    }
  } catch (e) {
    console.error("❌ Error en fallback LLM:", e);
  }

  return { intencion: "duda", nivel_interes: 1 };
}
