// backend/src/lib/channels/engine/fastpath/handleFastpathHybridTurn.ts

import { Pool } from "pg";
import type { Canal } from "../../../detectarIntencion";
import type { Lang } from "../clients/clientDb";
import { runFastpath } from "../../../fastpath/runFastpath";
import { naturalizeSecondaryOptionsLine } from "../../../fastpath/naturalizeSecondaryOptions";
import { getRecentHistoryForModel } from "../messages/getRecentHistoryForModel";
import { answerWithPromptBase } from "../../../answers/answerWithPromptBase";

const MAX_WHATSAPP_LINES = 9999; // mantenemos el mismo valor

export type FastpathHybridArgs = {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  idiomaDestino: Lang;
  userInput: string;
  inBooking: boolean;
  convoCtx: any;
  infoClave: string;
  detectedIntent: string | null;
  intentFallback: string | null;           // INTENCION_FINAL_CANONICA
  messageId: string | null;
  contactoNorm: string;
  promptBaseMem: string;
};

export type FastpathHybridResult = {
  handled: boolean;
  reply?: string;
  replySource?: string;
  intent?: string | null;
  ctxPatch?: any;
};

function isDmChatChannel(canal: Canal) {
  const c = String(canal || "").toLowerCase();
  return c === "whatsapp" || c === "facebook" || c === "instagram";
}

function buildMorePlansReply(fastpathText: string, idiomaDestino: Lang): string {
  const lines = fastpathText.split(/\r?\n/).map((l) => l.trim());

  const planLines: string[] = [];
  let reachedSchedules = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Saltar saludos y frases genéricas
    if (/^(hola|buenas|hi|hello)/i.test(line)) continue;
    if (/^estas son algunas alternativas/i.test(line)) continue;

    // Cortar cuando empiezan los horarios
    if (/^horarios?:/i.test(line) || /^schedules?:/i.test(line)) {
      reachedSchedules = true;
      break;
    }

    if (!reachedSchedules) {
      planLines.push(line);
    }
  }

  if (planLines.length === 0) {
    return fastpathText;
  }

  const header =
    idiomaDestino === "es"
      ? "Claro, aquí tienes otras opciones de planes:\n"
      : "Sure, here are some additional plan options:\n";

  return header + planLines.join("\n");
}

// Quitar el bloque de "Horarios:" y lo que sigue, salvo que el usuario lo haya pedido
function stripHorariosBlock(fastpathText: string): string {
  const lines = fastpathText.split(/\r?\n/);

  const result: string[] = [];
  let skippingSchedules = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (!skippingSchedules && /^horarios?:/i.test(line)) {
      // Desde aquí empezaban los horarios → los saltamos
      skippingSchedules = true;
      continue;
    }

    if (skippingSchedules) {
      // Si aparece un link de reserva / más info, lo volvemos a incluir y dejamos de saltar
      if (/^(m[aá]s info|más info|reserva aqu[ií]|reserve here|booking link)/i.test(line)) {
        skippingSchedules = false;
        if (line) result.push(raw);
      }
      // Todo lo demás (líneas de horarios) se salta
      continue;
    }

    result.push(raw);
  }

  return result.join("\n").trim();
}

export async function handleFastpathHybridTurn(
  args: FastpathHybridArgs
): Promise<FastpathHybridResult> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx,
    infoClave,
    detectedIntent,
    intentFallback,
    messageId,
    contactoNorm,
    promptBaseMem,
  } = args;

  const loweredInput = (userInput || "").toLowerCase();

  // Intención “final” de este turno (signals)
  const currentIntent = (detectedIntent || intentFallback || null) ?? null;

  // Palabras clave generales de precios / planes / horarios
  const isPriceOrScheduleKeyword =
    /\b(precio|precios|price|prices|pricing|plan|planes|membres[ií]a|membership|mensualidad|cu[eé]sta|costo|costos|tarifa|tarifas|fee|fees|rate|rates|horario|horarios|hora|hours?|schedule|schedules)\b/i
      .test(loweredInput);

  // Intenciones que consideramos “info de precios/planes/horarios del negocio”
  const isPriceIntent =
    currentIntent === "info_horarios_generales" ||
    currentIntent === "precio" ||
    currentIntent === "planes_precios";

  const hasRecentCatalogList =
    Array.isArray((convoCtx as any)?.last_catalog_plans) &&
    ((convoCtx as any).last_catalog_plans?.length ?? 0) > 0 &&
    Number.isFinite(Number((convoCtx as any)?.last_catalog_at)) &&
    Date.now() - Number((convoCtx as any).last_catalog_at) <= 30 * 60 * 1000; // 30m

  const asksOtherOptionsGeneric =
    /\b(other options|more options|other ones|more choices|otras opciones|otra opcion|más opciones|mas opciones)\b/i.test(
      loweredInput
    );

  const isPriceQuestionUser =
    isPriceOrScheduleKeyword ||
    isPriceIntent ||
    (asksOtherOptionsGeneric && hasRecentCatalogList);

  // 🔍 Señales específicas: planes + horarios en la misma pregunta
  const asksPlans = /plan|planes|membres/i.test(loweredInput);
  const asksHorarios = /horario|hora|horarios|hours|schedule/i.test(loweredInput);
  const wantsPlansAndHours = asksPlans && asksHorarios;

  // Pregunta de seguimiento: "otros/más planes"
  const isMorePlansFollowup =
    /\b(otro(?:s)?|mas|más|adicional(?:es)?|otra opcion|otras opciones|another|other|more|additional)\b/.test(
      loweredInput
    ) &&
    /\b(plan(?:es)?|membres[ií]a|membership|producto(?:s)?)\b/.test(loweredInput);

  // Pregunta de DETALLE de algo (qué incluye / qué trae)
  // Genérico: sirve para cualquier servicio, plan, producto, paquete, etc.
  const isPlanDetailQuestion =
    /\b(que incluye|qué incluye|que trae|qué trae|incluye|incluyen|mas detalle|más detalle|dame mas detalle|dame más detalle|detalle|detalles|what\s+is\s+included|what\s+does.*include|what.*include|more detail|more details|give me more detail|tell me more about)\b/i.test(
        loweredInput
    );

  // Intención efectiva que verá Fastpath
  const fpIntent = isPriceQuestionUser
    ? (detectedIntent || intentFallback || "precio")
    : (detectedIntent || intentFallback || null);

  // 1️⃣ Ejecutar Fastpath "puro" (DB, includes, etc.)
  const fp = await runFastpath({
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx: convoCtx as any,
    infoClave,
    detectedIntent: fpIntent,
    maxDisambiguationOptions: 10,
    lastServiceTtlMs: 60 * 60 * 1000,
  });

  // Si no manejó nada, devolvemos directo
  if (!fp.handled) {
    return { handled: false };
  }

  // ✅ declarar ctxPatch primero
  const ctxPatch: any = fp.ctxPatch ? { ...fp.ctxPatch } : {};

  // ✅ HARD BYPASS: si Fastpath ya respondió desde DB con precios/catálogo,
  // NUNCA pasar por LLM (evita precios inventados).
  const DB_PRICE_SOURCES = new Set([
    "catalog_db",
    "price_summary_db",
    "price_fastpath_db",
    "price_disambiguation_db",
    "price_missing_db",
    "price_summary_db_empty",
  ]);

  if (isDmChatChannel(canal) && DB_PRICE_SOURCES.has(fp.source as any)) {
    console.log("[CHAT][FASTPATH] HARD BYPASS DB_PRICE_SOURCE -> send fastpath (no LLM)", {
      source: fp.source,
      intent: fp.intent,
    });

    return {
      handled: true,
      reply: fp.reply,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  // 2️⃣ awaitingEffect: set_awaiting_yes_no → lo manejamos aquí
  if (fp.awaitingEffect?.type === "set_awaiting_yes_no") {
    const { setAwaitingState } = await import("../../../awaiting/setAwaitingState");
    await setAwaitingState(pool, {
      tenantId,
      canal,
      senderId: contactoNorm,
      field: "yes_no",
      payload: fp.awaitingEffect.payload,
      ttlSeconds: fp.awaitingEffect.ttlSeconds,
    });
  }

  // 3️⃣ Texto factual base que sale de Fastpath
  let fastpathText = fp.reply;

  // Si el usuario preguntó "qué incluye...", NO queremos meter los horarios en el bloque
  if (isPlanDetailQuestion) {
    fastpathText = stripHorariosBlock(fastpathText);
  }

  // 3.1️⃣ BYPASS LLM PARA DETALLE DE SERVICIO ("qué incluye X")
  // Si Fastpath ya resolvió info_servicio (incluye/qué trae), en WhatsApp/Meta
  // NO queremos pasar por el LLM: mandamos la respuesta tal cual.
  if (
    isDmChatChannel(canal) &&
    fp.source === "service_list_db" &&
    (fp.intent === "info_servicio" || isPlanDetailQuestion)
  ) {
    console.log("[CHAT][FASTPATH] detalle_servicio directo (sin LLM)", {
      source: fp.source,
      intent: fp.intent,
      isPlanDetailQuestion,
    });

    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || currentIntent || "info_servicio",
      ctxPatch,
    };
  }

  const isPlansList =
    fp.source === "service_list_db" &&
    (convoCtx as any)?.last_list_kind === "plan";

  const hasPkgs = (convoCtx as any)?.has_packages_available === true;

  // 3.5️⃣ WHATSAPP/META + PREGUNTA DE PRECIOS/PLANES: NO PASAR POR LLM
  // EXCEPCIÓN 1: si es "planes + horarios", dejamos que pase al modo híbrido
  // EXCEPCIÓN 2: tratamos distinto follow-up ("otros planes") y detalle de plan ("qué incluye")
  if (
    isDmChatChannel(canal) &&
    isPriceQuestionUser &&
    !wantsPlansAndHours &&
    !isPlanDetailQuestion
  ) {
    console.log("[CHAT][FASTPATH] Price question -> send fastpath", {
      source: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      isMorePlansFollowup,
      isPlanDetailQuestion,
    });

    let replyText = fastpathText;

    if (isMorePlansFollowup) {
      // Modo "otras opciones": solo lista adicional, sin horarios ni saludo
      replyText = buildMorePlansReply(fastpathText, idiomaDestino);
    }

    return {
      handled: true,
      reply: replyText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  // 🔍 detecta si ya trae link o viene de info_clave_*
  const hasLinkInFastpath = /https?:\/\/\S+/i.test(fastpathText);
  const isInfoClaveSource = String(fp.source || "").startsWith("info_clave");

  // 4️⃣ BYPASS LLM EN WHATSAPP/META si ya hay link o viene de info_clave
  if (isDmChatChannel(canal) && (hasLinkInFastpath || isInfoClaveSource)) {
    console.log("[CHAT][FASTPATH] Bypass LLM (link/info_clave)", {
      source: fp.source,
      hasLinkInFastpath,
    });

    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  // 5️⃣ Para otros canales, naturalizar línea secundaria (planes + paquetes)
  if (canal !== "whatsapp" && isPlansList && hasPkgs) {
    fastpathText = await naturalizeSecondaryOptionsLine({
      tenantId,
      idiomaDestino,
      canal,
      baseText: fastpathText,
      primary: "plans",
      secondaryAvailable: true,
      maxLines: MAX_WHATSAPP_LINES,
    });
  }

  // 6️⃣ MODO HÍBRIDO PARA WHATSAPP Y META (FB/IG)
  const isDm = isDmChatChannel(canal);

  if (isDm) {
    const history = await getRecentHistoryForModel({
      tenantId,
      canal,
      fromNumber: contactoNorm,
      excludeMessageId: messageId || undefined,
      limit: 12,
    });

    const NO_NUMERIC_MENUS =
      idiomaDestino === "en"
        ? "RULE: Do NOT present numbered menus or ask the user to reply with a number. If you need clarification, ask ONE short question. Numbered picks are handled by the system, not you."
        : "REGLA: NO muestres menús numerados ni pidas que respondan con un número. Si necesitas aclarar, haz UNA sola pregunta corta. Las selecciones por número las maneja el sistema, no tú.";

    const PRICE_QUALIFIER_RULE =
      idiomaDestino === "en"
        ? "RULE: If a price is described as 'FROM/STARTING AT' (or 'desde'), you MUST keep that qualifier. Never rewrite it as an exact price. Use: 'starts at $X' / 'from $X'."
        : "REGLA: Si un precio está descrito como 'DESDE' (o 'from/starting at'), DEBES mantener ese calificativo. Nunca lo conviertas en precio exacto. Usa: 'desde $X'.";

    const NO_PRICE_INVENTION_RULE =
      idiomaDestino === "en"
        ? "RULE: Do not invent exact prices. Only mention prices if explicitly present in the provided business info or in SYSTEM_STRUCTURED_DATA, and preserve ranges/qualifiers."
        : "REGLA: No inventes precios exactos. Solo menciona precios si están explícitos en la info del negocio o en DATOS_ESTRUCTURADOS_DEL_SISTEMA, y preserva rangos/calificativos (DESDE).";

    const PRICE_LIST_FORMAT_RULE =
      idiomaDestino === "en"
        ? [
            "RULE: If your reply mentions any prices or plans from SYSTEM_STRUCTURED_DATA, you MUST format them as a bullet list.",
            "- You may start with 0–1 very short intro line (e.g. 'Main prices are:').",
            "- Then put ONE option per line like: '• Plan Gold Autopay: $165.99/month – short benefit'.",
            "- NEVER put several different prices or plans in one long paragraph.",
            "- If the user also asks about schedules/hours, answer hours in 1 short sentence and then show the prices as a bullet list.",
          ].join(" ")
        : [
            "REGLA: Si tu respuesta menciona precios o planes tomados de DATOS_ESTRUCTURADOS_DEL_SISTEMA, DEBES formatearlos como lista con viñetas.",
            "- Puedes empezar con 0–1 línea muy corta de introducción (por ejemplo: 'Los precios principales son:').",
            "- Luego usa UNA línea por opción, por ejemplo: '• Plan Gold Autopay: $165.99/mes – beneficio breve'.",
            "- NUNCA metas varios precios o planes distintos en un solo párrafo largo.",
            "- Si el usuario también pregunta por horarios, responde los horarios en 1 frase corta y después muestra los precios como lista con viñetas.",
          ].join(" ");

    const CHANNEL_TONE_RULE =
      idiomaDestino === "en"
        ? "RULE: You may rephrase for a natural chat/DM tone, but DO NOT change amounts, ranges, or plan/service names."
        : "REGLA: Puedes re-redactar para que suene natural en chat/DM, pero NO cambies montos, rangos ni nombres de planes/servicios.";

    // Bloque especial solo cuando pidió “planes + horarios”
    let forcedListBlock = "";
    if (wantsPlansAndHours && infoClave) {
      forcedListBlock =
        idiomaDestino === "es"
          ? `
REGLA ESPECIAL PARA ESTE TURNO:
- El usuario pidió PLANES + HORARIOS.
- Debes responder SIEMPRE en formato LISTA.
- Prohibido párrafos largos.
- Estructura EXACTA:
  1) "Planes principales:" seguido de 3–5 bullets (un plan por línea).
  2) "Horarios:" seguido de bullets con horarios extraídos SOLO de BUSINESS_GENERAL_INFO (info_clave).
  3) El link de reservas en su propia línea.
  4) CTA final en 1 línea.
- NO inventes horarios. Usa solo los que aparezcan literalmente en BUSINESS_GENERAL_INFO.
- NO resumas horarios como "varían" ni "desde temprano". Usa solo los reales.
          `
          : `
SPECIAL RULE FOR THIS TURN:
- The user asked for PLANS + HOURS.
- You MUST answer in LIST FORMAT.
- No long paragraphs.
- Structure:
  1) "Main plans:" with 3–5 bullet lines.
  2) "Schedules:" with bullets using ONLY hours found in BUSINESS_GENERAL_INFO.
  3) Booking link as a separate line.
  4) CTA in one line.
- DO NOT invent hours. Use only literal ones.
          `;
    }

    const promptConFastpath = [
      promptBaseMem,
      "",
      forcedListBlock,
      "",
      "DATOS_ESTRUCTURADOS_DEL_SISTEMA (úsalos como fuente de verdad, sin cambiar montos ni nombres de planes/servicios):",
      fastpathText,
      "",
      "INSTRUCCIONES_DE_ESTILO_PARA_ESTE TURNO:",
      NO_NUMERIC_MENUS,
      PRICE_QUALIFIER_RULE,
      NO_PRICE_INVENTION_RULE,
      PRICE_LIST_FORMAT_RULE,
      "",
      CHANNEL_TONE_RULE,
    ].join("\n");

    const composed = await answerWithPromptBase({
      tenantId,
      promptBase: promptConFastpath,
      userInput,              // mensaje real del cliente
      history,
      idiomaDestino,
      canal,                  // 👈 aquí usamos el canal real (whatsapp o meta)
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: fastpathText, // si falla LLM, al menos enviamos Fastpath
    });

    const text = (composed.text || "").toLowerCase().trim();

    // 7️⃣ Detectar CTA YES/NO del LLM y preparar awaiting_yes_no_action
    const isYesNoCTA =
      /\?\s*$/.test(text) &&
      (/\bte gustar[íi]a\b/.test(text) ||
        /\bquieres\b/.test(text) ||
        /\bdeseas\b/.test(text) ||
        /\bwould you like\b/.test(text) ||
        /\bdo you want\b/.test(text));

    if (isYesNoCTA) {
      const sid = (convoCtx as any)?.last_service_id || null;
      const sname = (convoCtx as any)?.last_service_name || null;

      let serviceUrl: string | null = null;
      if (sid) {
        const r = await pool.query(
          `SELECT service_url FROM services WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
          [sid, tenantId]
        );
        serviceUrl = r.rows[0]?.service_url || null;
      }

      if (sid && serviceUrl) {
        ctxPatch.awaiting_yes_no_action = {
          kind: "cta_yes_no_service",
          serviceId: sid,
          label: sname || "Reserva",
          link: serviceUrl,
        };
      }
    }

    return {
      handled: true,
      reply: composed.text,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  console.log("[DM_CHANNEL_CHECK]", { canal, isDm });
  
  // 8️⃣ Otros canales (no WhatsApp/Meta): devolvemos fastpath “plano”
  return {
    handled: true,
    reply: fastpathText,
    replySource: fp.source,
    intent: fp.intent || detectedIntent || intentFallback || null,
    ctxPatch,
  };
}