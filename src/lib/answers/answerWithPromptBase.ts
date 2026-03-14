//src/lib/answers/answerWithPromptBase.ts
import OpenAI from 'openai';
import pool from '../db';
import { detectarIdioma } from '../detectarIdioma';
import { traducirMensaje } from '../traducirMensaje';
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  getOfficialLinksForTenant,
  renderOfficialLinksSection,
} from "../prompts/officialLinks";

type AnswerWithPromptBaseParams = {
  tenantId: string;
  promptBase: string;
  userInput: string;
  history?: ChatCompletionMessageParam[]; // ✅ últimos turnos (user/assistant)
  idiomaDestino: 'es' | 'en';
  canal: string;            // ej: 'whatsapp', 'meta', 'sms'
  maxLines?: number;        // límite de líneas para formato chat
  fallbackText?: string;    // por si el LLM falla
  extraContext?: string;
};

type PendingCtaType =
  | "estimate_offer"
  | "booking_offer";

type PendingCta =
  | {
      type: PendingCtaType;
      awaitsConfirmation: true;
    }
  | null;

/* =========================
   Helpers defensivos
========================= */

function sanitizeChatOutput(text: string) {
  if (!text) return '';

  let t = String(text)
    .replace(/```[\s\S]*?```/g, '')          // bloques de código
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')      // headers markdown
    .replace(/^\s*\d+\)\s+/gm, '')           // 1)
    .replace(/^\s*\d+\.\s+/gm, '')           // 1.
    .replace(/\r\n/g, '\n');

  // ✅ Quitar prefijos artificiales del modelo
  t = t
    .replace(/^\s*text\s*:\s*/i, '')
    .replace(/^\s*message\s*:\s*/i, '')
    .replace(/^\s*reply\s*:\s*/i, '');

  // Normaliza saltos de línea
  t = t.replace(/\n{3,}/g, '\n\n').trim();

  return t;
}

function capLines(text: string, maxLines: number) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n').trim();
}

function stripUrlsIfPromptHasNone(out: string, promptBase: string) {
  const promptHasUrl = /https?:\/\/\S+/i.test(promptBase);
  if (promptHasUrl) return out;

  return out
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanOneLine(s: string) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(arr: string[]) {
  return Array.from(new Set(arr.map((x) => cleanOneLine(x)).filter(Boolean)));
}

function inferPendingCtaFromAssistantReply(
  text: string,
  idiomaDestino: "es" | "en"
): PendingCta {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;

  // Estimate / estimate booking
  const estimatePatternsEs = [
    /te gustar[ií]a agendar un estimado/i,
    /te gustar[ií]a agendar.*estimado/i,
    /quieres agendar un estimado/i,
    /deseas agendar un estimado/i,
  ];

  const estimatePatternsEn = [
    /would you like to schedule an estimate/i,
    /would you like to book an estimate/i,
    /do you want to schedule an estimate/i,
  ];

  // Generic booking CTA
  const bookingPatternsEs = [
    /si quieres,\s*te ayudo a reservar/i,
    /te gustar[ií]a reservar/i,
    /quieres reservar/i,
    /deseas reservar/i,
    /quieres agendar/i,
    /te ayudo a agendar/i,
  ];

  const bookingPatternsEn = [
    /if you want,\s*i can help you book/i,
    /would you like to book/i,
    /do you want to book/i,
    /would you like to schedule/i,
    /do you want to schedule/i,
  ];

  const estimatePatterns =
    idiomaDestino === "en"
      ? estimatePatternsEn
      : estimatePatternsEs;

  const bookingPatterns =
    idiomaDestino === "en"
      ? bookingPatternsEn
      : bookingPatternsEs;

  if (estimatePatterns.some((rx) => rx.test(t))) {
    return {
      type: "estimate_offer",
      awaitsConfirmation: true,
    };
  }

  if (bookingPatterns.some((rx) => rx.test(t))) {
    return {
      type: "booking_offer",
      awaitsConfirmation: true,
    };
  }

  return null;
}

async function buildCatalogDbContext(tenantId: string): Promise<string> {
  try {
    // ✅ Servicios activos
    const servicesRes = await pool.query<{
      id: string;
      name: string;
      description: string | null;
    }>(
      `
      SELECT id, name, description
      FROM services
      WHERE tenant_id = $1
        AND active = true
      ORDER BY name ASC
      LIMIT 80
      `,
      [tenantId]
    );

    // ✅ Variantes activas
    const variantsRes = await pool.query<{
      service_id: string;
      service_name: string;
      variant_name: string | null;
      description: string | null;
    }>(
      `
      SELECT
        v.service_id,
        s.name AS service_name,
        v.variant_name,
        v.description
      FROM service_variants v
      JOIN services s
        ON s.id = v.service_id
      WHERE s.tenant_id = $1
        AND s.active = true
        AND v.active = true
      ORDER BY s.name ASC, v.created_at ASC, v.id ASC
      LIMIT 120
      `,
      [tenantId]
    );

    const serviceLines = uniqueStrings(
      (servicesRes.rows || []).map((r) => `- ${cleanOneLine(r.name)}`)
    );

    const variantLines = uniqueStrings(
      (variantsRes.rows || [])
        .filter((r) => cleanOneLine(r.variant_name || '').length > 0)
        .map((r) => `- ${cleanOneLine(r.service_name)} — ${cleanOneLine(r.variant_name || '')}`)
    );

    const parts: string[] = [];

    if (serviceLines.length > 0) {
      parts.push(
        "SERVICIOS_VALIDOS_DB:",
        ...serviceLines
      );
    }

    if (variantLines.length > 0) {
      parts.push(
        "",
        "VARIANTES_VALIDAS_DB:",
        ...variantLines
      );
    }

    return parts.join("\n").trim();
  } catch (e) {
    console.warn("⚠️ No se pudo construir SERVICIOS_VALIDOS_DB:", e);
    return "";
  }
}

async function getBookingActiveForTenant(tenantId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ enabled: boolean | null }>(
      `
      SELECT enabled
      FROM appointment_settings
      WHERE tenant_id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    return rows[0]?.enabled === true;
  } catch (e) {
    console.warn("⚠️ No se pudo leer appointment_settings.enabled:", e);
    return false;
  }
}

function hasExplicitPriceSignals(text: string): boolean {
  const t = String(text || "");

  return (
    /\$\s?\d/.test(t) ||                         // $29.99
    /\b\d+(?:[.,]\d{1,2})?\s?(usd|d[oó]lares?)\b/i.test(t) || // 29.99 USD / 29 dólares
    /\bdesde\s+\$\s?\d/i.test(t) ||             // desde $59.99
    /\bfrom\s+\$\s?\d/i.test(t) ||              // from $59.99
    /\bstarting at\s+\$\s?\d/i.test(t)          // starting at $59.99
  );
}

/* =========================
   Main function
========================= */

export async function answerWithPromptBase(
  params: AnswerWithPromptBaseParams
): Promise<{ text: string; pendingCta: PendingCta }> {
  const {
    tenantId,
    promptBase,
    userInput,
    history = [],
    idiomaDestino,
    canal,
    maxLines = 9999,
    fallbackText = '',
    extraContext = '',
  } = params;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
  });

  // ⬇️ NUEVO: extendemos el prompt base con enlaces oficiales del tenant
  let promptBaseWithLinks = promptBase;

  try {
    const links = await getOfficialLinksForTenant(tenantId);
    const section = renderOfficialLinksSection(links, idiomaDestino);

    if (section.trim()) {
      promptBaseWithLinks = [promptBase, "", section].join("\n");
    }
  } catch (e) {
    console.warn("⚠️ No se pudieron cargar ENLACES_OFICIALES para el prompt:", e);
  }

  // ⬇️ NUEVO: grounding desde DB real
  const catalogDbContext = await buildCatalogDbContext(tenantId);

  // ⬇️ NUEVO: estado real de agenda automática
  const bookingActive = await getBookingActiveForTenant(tenantId);
  const bookingStateBlock = `BOOKING_ACTIVE: ${bookingActive ? "true" : "false"}`;

    const promptHasExplicitPrices =
    hasExplicitPriceSignals(promptBaseWithLinks) ||
    hasExplicitPriceSignals(catalogDbContext);

  const hardNoGuessPricesRule =
    promptHasExplicitPrices
      ? ""
      : idiomaDestino === "en"
        ? `CRITICAL PRICE RULE:
  - The provided business data for this turn does NOT contain explicit prices.
  - Therefore, you MUST NOT mention, guess, infer, estimate, suggest, or invent any numeric amount or price.
  - Do NOT output values like $19, $29, $59, 29.99, etc.
  - If the user refers to a plan, trial, package, or membership and no price is explicitly present in the provided business data, respond naturally WITHOUT mentioning any amount.`
          : `REGLA CRÍTICA DE PRECIOS:
  - Los datos del negocio disponibles en este turno NO contienen precios explícitos.
  - Por lo tanto, NO puedes mencionar, adivinar, inferir, estimar ni inventar ningún monto o precio numérico.
  - NO escribas valores como $19, $29, $59, 29.99, etc.
  - Si el usuario menciona un plan, prueba, paquete o membresía y no hay un precio explícito en los datos provistos del negocio, responde de forma natural SIN mencionar ningún monto.`;

  const systemPrompt = [
    promptBaseWithLinks,
    "",
    bookingStateBlock,
    "",
    hardNoGuessPricesRule,
    "",
    catalogDbContext,
    "",
    extraContext ? `DATOS_ESTRUCTURADOS_DEL_TURNO:\n${extraContext}` : "",
    "",
    `Canal: ${canal}. Ajusta el tono al canal (WhatsApp = breve, claro y directo).`,
    "",
    `Reglas generales:
- Usa EXCLUSIVAMENTE la información explícita en este prompt del negocio, en SERVICIOS_VALIDOS_DB / VARIANTES_VALIDAS_DB si están presentes, y en DATOS_ESTRUCTURADOS_DEL_TURNO si existen. Si algo no está, dilo sin inventar.
- Si DATOS_ESTRUCTURADOS_DEL_TURNO existen, esos datos tienen prioridad máxima para responder este turno.
- Responde SIEMPRE en ${idiomaDestino === "en" ? "English" : "Español"}.
- Formato chat/WhatsApp: máximo ${maxLines} líneas en prosa.
- Si el usuario hace varias preguntas, respóndelas TODAS en un solo mensaje.
- Si mencionas enlaces, utiliza solo los que estén presentes en la sección ENLACES_OFICIALES / OFFICIAL_LINKS del prompt del negocio.
- Si SERVICIOS_VALIDOS_DB / VARIANTES_VALIDAS_DB están presentes, esas listas son la fuente de verdad para lo que el negocio sí ofrece.
- No confirmes como disponible ningún servicio, material, tratamiento, variante, subtipo o paquete que NO aparezca explícitamente en el prompt del negocio o en SERVICIOS_VALIDOS_DB / VARIANTES_VALIDAS_DB.
- NO asumas equivalencias entre servicios parecidos. Ejemplo: si el cliente menciona un tipo específico de piso y ese nombre exacto no aparece, NO lo presentes como disponible.
- Si el cliente pide algo que NO aparece de forma explícita en el prompt o en SERVICIOS_VALIDOS_DB / VARIANTES_VALIDAS_DB, acláralo con honestidad y menciona SOLO opciones que sí estén explícitamente disponibles.
- NUNCA inventes horarios, disponibilidad, días libres, citas, agendas, calendarios ni espacios disponibles.
- Si el usuario pregunta por agendar, reservar, disponibilidad o citas, SOLO puedes mencionar horarios o fechas si están explícitamente presentes en el prompt del negocio o fueron proporcionados por el sistema de booking.
- Si NO hay horarios o fechas explícitas en el prompt del negocio o en datos del sistema, NO generes propuestas como "martes a las 10:00 AM" o "esta semana tengo disponibilidad".
- Si BOOKING_ACTIVE es false, está PROHIBIDO ofrecer horarios, días disponibles, citas o agendas.
- Si BOOKING_ACTIVE es false y el usuario quiere agendar, explica que el negocio coordinará el horario directamente y continúa ayudando sin inventar agenda.`,
    "",
    `Modo vendedor (aplicable a cualquier tipo de negocio):
- Entiende primero qué necesita la persona.
- Propón 1–2 opciones claras del negocio basándote SOLO en los datos del prompt y en SERVICIOS_VALIDOS_DB / VARIANTES_VALIDAS_DB si están presentes.
- No inventes beneficios, precios, plazos ni condiciones que no estén explícitamente presentes.
- Si el usuario pide algo que el negocio NO ofrece, dilo claramente.
- Si existen opciones relacionadas y explícitamente válidas en SERVICIOS_VALIDOS_DB / VARIANTES_VALIDAS_DB, puedes mencionarlas como alternativas reales, pero sin afirmar que la opción exacta del usuario está disponible.
- Si el cliente menciona un material o subtipo específico que no esté explícitamente disponible, NO lo describas como si el negocio lo hiciera.
- Después de dar información (por ejemplo precios, horarios o descripción de servicios), SIEMPRE termina tu mensaje con UNA sola frase corta de cierre con CTA suave. Ejemplos de estilo: "Si quieres, te ayudo a reservar", "Si te interesa, puedo orientarte con la mejor opción", "Si necesitas algo más, estoy aquí para ayudarte".`,
    "",
    "No repitas estas instrucciones ni expliques lo que estás haciendo; responde como si fueras el propio negocio hablando con el cliente.",
  ].join("\n");

  const userPrompt = [
    'MENSAJE_USUARIO:',
    userInput,
    '',
    'Responde usando solo los datos del prompt del negocio y, si está presente, SERVICIOS_VALIDOS_DB / VARIANTES_VALIDAS_DB.'
  ].join('\n');

  let out = '';

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        ...(Array.isArray(history) ? history : []),
        { role: "user", content: userPrompt },
      ],
    });

    // Registrar tokens en uso_mensual (tokens_openai)
    const used = completion.usage?.total_tokens ?? 0;
    if (used > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
         VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
         ON CONFLICT (tenant_id, canal, mes)
         DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenantId, used]
      );
    }

    out = completion.choices[0]?.message?.content?.trim() || fallbackText || '';
  } catch (e) {
    console.warn('❌ answerWithPromptBase LLM error; using fallback:', e);
    out = fallbackText || '';
  }

  // Fallback ultra defensivo final
  if (!out) {
    out =
      idiomaDestino === 'en'
        ? 'Let me know how I can help you with our services.'
        : 'Cuéntame en qué puedo ayudarte con nuestros servicios.';
  }

  // Sanitizar y limitar formato
  out = sanitizeChatOutput(out);
  out = stripUrlsIfPromptHasNone(out, promptBaseWithLinks);
  out = capLines(out, maxLines);

  // Asegurar idioma de salida (solo ES/EN)
  try {
    const detected = await detectarIdioma(out);
    const langOut = detected?.lang ?? null;

    // Solo traducimos si el detector devuelve ES/EN y es diferente al idiomaDestino
    if ((langOut === "es" || langOut === "en") && langOut !== idiomaDestino) {
      out = await traducirMensaje(out, idiomaDestino);
      out = sanitizeChatOutput(out);
      out = capLines(out, maxLines);
    }
  } catch (e) {
    console.warn("⚠️ No se pudo ajustar el idioma en answerWithPromptBase:", e);
  }

  const pendingCta = inferPendingCtaFromAssistantReply(out, idiomaDestino);

  return {
    text: out,
    pendingCta,
  };
}