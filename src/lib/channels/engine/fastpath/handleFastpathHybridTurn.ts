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

  // Intención “final” (de signals)
  const currentIntent = (detectedIntent || intentFallback || null) ?? null;

  // Palabras clave de precios y horarios (ES/EN, genérico, no por negocio)
  const isPriceOrScheduleKeyword =
    /\b(precio|precios|price|prices|plan|planes|membres[ií]a|membership|mensualidad|cu[eé]sta|costo|costos|tarifa|tarifas|fee|fees|rate|rates|horario|horarios|hora|hours?|schedule|schedules)\b/i
      .test(loweredInput);

  // Intenciones que consideramos “info general de precios/horarios”
  const isPriceIntent =
    currentIntent === "info_horarios_generales" ||
    currentIntent === "precio" ||
    currentIntent === "planes_precios"; // si no usas estos dos, los puedes quitar

  const isPriceQuestionUser = isPriceOrScheduleKeyword || isPriceIntent;

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
    detectedIntent: detectedIntent || intentFallback || null,
    maxDisambiguationOptions: 5,
    lastServiceTtlMs: 60 * 60 * 1000,
  });

  // Si no manejó nada, devolvemos directo
  if (!fp.handled) {
    return { handled: false };
  }

  const ctxPatch: any = fp.ctxPatch ? { ...fp.ctxPatch } : {};

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

  const isPlansList =
    fp.source === "service_list_db" &&
    (convoCtx as any)?.last_list_kind === "plan";

  const hasPkgs = (convoCtx as any)?.has_packages_available === true;

  // 🛑 WHATSAPP + PREGUNTA DE PRECIOS: NO PASAR POR LLM
  if (canal === "whatsapp" && isPriceQuestionUser) {
    console.log("[WHATSAPP][FASTPATH] Price question -> send raw fastpath list", {
      source: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
    });

    return {
      handled: true,
      reply: fastpathText,
      replySource: fp.source,
      intent: fp.intent || detectedIntent || intentFallback || null,
      ctxPatch,
    };
  }

  // 🔍 detecta si ya trae link o viene de info_clave_*
  const hasLinkInFastpath = /https?:\/\/\S+/i.test(fastpathText);
  const isInfoClaveSource = String(fp.source || "").startsWith("info_clave");

  // 4️⃣ BYPASS LLM EN WHATSAPP si ya hay link o viene de info_clave
  if (canal === "whatsapp" && (hasLinkInFastpath || isInfoClaveSource)) {
    console.log("[WHATSAPP][FASTPATH] Bypass LLM (link/info_clave)", {
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

  // 6️⃣ MODO HÍBRIDO SOLO PARA WHATSAPP
  if (canal === "whatsapp") {
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
                "- If the user also asks about schedules/hours, answer hours in 1 short sentence and then show the prices as a bullet list."
            ].join(" ")
            : [
                "REGLA: Si tu respuesta menciona precios o planes tomados de DATOS_ESTRUCTURADOS_DEL_SISTEMA, DEBES formatearlos como lista con viñetas.",
                "- Puedes empezar con 0–1 línea muy corta de introducción (por ejemplo: 'Los precios principales son:').",
                "- Luego usa UNA línea por opción, por ejemplo: '• Plan Gold Autopay: $165.99/mes – beneficio breve'.",
                "- NUNCA metas varios precios o planes distintos en un solo párrafo largo.",
                "- Si el usuario también pregunta por horarios, responde los horarios en 1 frase corta y después muestra los precios como lista con viñetas."
            ].join(" ");

    const promptConFastpath = [
      promptBaseMem,
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
      idiomaDestino === "en"
        ? "RULE: You may rephrase for a natural WhatsApp tone, but DO NOT change amounts, ranges, or plan/service names."
        : "REGLA: Puedes re-redactar para que suene natural en WhatsApp, pero NO cambies montos, rangos ni nombres de planes/servicios.",
    ].join("\n");

    const composed = await answerWithPromptBase({
      tenantId,
      promptBase: promptConFastpath,
      userInput,                  // mensaje real del cliente
      history,
      idiomaDestino,
      canal: "whatsapp",
      maxLines: MAX_WHATSAPP_LINES,
      fallbackText: fastpathText, // si falla LLM, al menos enviamos Fastpath
    });

    const text = (composed.text || "").toLowerCase().trim();

    // 7️⃣ Detectar CTA YES/NO del LLM y preparar awaiting_yes_no_action
    const isYesNoCTA =
      /\?\s*$/.test(text) &&
      (
        /\bte gustar[íi]a\b/.test(text) ||
        /\bquieres\b/.test(text) ||
        /\bdeseas\b/.test(text) ||
        /\bwould you like\b/.test(text) ||
        /\bdo you want\b/.test(text)
      );

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
        // definimos awaiting_yes_no_action en ctx
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

  // 8️⃣ Otros canales (no WhatsApp): devolvemos fastpath “plano”
  return {
    handled: true,
    reply: fastpathText,
    replySource: fp.source,
    intent: fp.intent || detectedIntent || intentFallback || null,
    ctxPatch,
  };
}