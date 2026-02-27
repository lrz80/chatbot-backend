// backend/src/lib/channels/engine/sm/handleStateMachineTurn.ts

import { Pool } from "pg";
import type { Lang } from "../clients/clientDb";
import type { Canal } from "../../../detectarIntencion";

import { applyAwaitingEffects } from "../state/applyAwaitingEffects";
import { getRecentHistoryForModel } from "../messages/getRecentHistoryForModel";
import { answerWithPromptBase } from "../../../answers/answerWithPromptBase";
import { getBienvenidaPorCanal } from "../../../getPromptPorCanal";
import {
  upsertSelectedChannelDB,
  upsertIdiomaClienteDB,
  type SelectedChannel,
} from "../clients/clientDb";

type StateMachineFn = (args: any) => Promise<any>;

export type HandleStateMachineTurnArgs = {
  pool: Pool;
  sm: StateMachineFn;

  tenant: any;
  canal: Canal;
  contactoNorm: string;
  userInput: string;
  messageId: string | null;
  idiomaDestino: Lang;

  promptBase: string;    // base SIN memoria (para payment link)
  promptBaseMem: string; // base + memoria, si aplica

  MAX_LINES: number;

  // booking guardrail (ya definido en el webhook)
  tryBooking: (mode: "guardrail" | "gate", tag: string) => Promise<boolean>;

  // estructura "event" mínima que usabas
  tenantId: string;
  eventUserInput: string;

  // helpers de reply que siguen viviendo en el webhook
  replyAndExit: (text: string, source: string, intent?: string | null) => Promise<void>;
};

/**
 * Devuelve true si la SM ya manejó el turno (silence o reply),
 * para que el webhook haga `if (handled) return;`
 */
export async function handleStateMachineTurn(
  args: HandleStateMachineTurnArgs
): Promise<boolean> {
  const {
    pool,
    sm,
    tenant,
    canal,
    contactoNorm,
    userInput,
    messageId,
    idiomaDestino,
    promptBase,
    promptBaseMem,
    MAX_LINES,
    tryBooking,
    tenantId,
    eventUserInput,
    replyAndExit,
  } = args;

  const loweredInput = (userInput || "").toLowerCase();

  const isPriceQuestionUser =
    /\b(precio|precios|price|prices|plan|planes|membres[ií]a|membership|mensualidad|cu[eé]sta|costo|costos|tarifa|tarifas|fee|fees|rate|rates)\b/i
      .test(loweredInput);

  // ===============================
  // 🔁 Ejecutar State Machine
  // ===============================
  const smResult = await sm({
    pool,
    tenantId,
    canal,
    contacto: contactoNorm,
    userInput,
    messageId,
    idiomaDestino,
    promptBase, // el base SIN memoria (para payment link)
    parseDatosCliente: undefined,         // se inyecta desde el webhook con `as any`
    extractPaymentLinkFromPrompt: undefined,
    PAGO_CONFIRM_REGEX: undefined,
  } as any);

  if (smResult.action === "silence") {
    console.log("🧱 [SM] silence:", smResult.reason);
    return true;
  }

  if (smResult.action !== "reply") {
    // SM no se hace cargo → que siga el pipeline normal
    return false;
  }

  // ===============================
  // 🎯 SM => REPLY
  // ===============================

  // Aplica side-effects declarados (awaiting, etc.)
  if (smResult.transition?.effects) {
    await applyAwaitingEffects({
      pool,
      tenantId,
      canal,
      contacto: contactoNorm,
      effects: smResult.transition.effects,
      upsertSelectedChannelDB: (
        tenantId: string,
        canal: string,
        contacto: string,
        selected: SelectedChannel
      ) =>
        upsertSelectedChannelDB(pool, tenantId, canal, contacto, selected),
      upsertIdiomaClienteDB: (
        tenantId: string,
        canal: string,
        contacto: string,
        idioma: Lang
      ) =>
        upsertIdiomaClienteDB(pool, tenantId, canal, contacto, idioma),
    });
  }

  const history = await getRecentHistoryForModel({
    tenantId,
    canal,
    fromNumber: contactoNorm,
    excludeMessageId: messageId ?? undefined,
    limit: 12,
  });

  if (await tryBooking("guardrail", "sm_reply")) {
    // Booking pipeline ya respondió
    return true;
  }

  const NO_NUMERIC_MENUS =
    idiomaDestino === "en"
      ? "RULE: Do NOT present numbered menus or ask the user to reply with a number. If you need clarification, ask ONE short question. Numbered picks are handled by the system, not you."
      : "REGLA: NO muestres menús numerados ni pidas que respondan con un número. Si necesitas aclarar, haz UNA sola pregunta corta. Las selecciones por número las maneja el sistema, no tú.";

  const LIST_FOLLOWUP_RULE =
    idiomaDestino === "en"
      ? "RULE: If you provide a list of services/options, ALWAYS end with ONE short question: 'Which one are you interested in?'"
      : "REGLA: Si das una lista de servicios/opciones, SIEMPRE termina con UNA pregunta corta: '¿Cuál te interesa?'";

  const PRICE_QUALIFIER_RULE =
    idiomaDestino === "en"
      ? "RULE: If a price is described as 'FROM/STARTING AT' (or 'desde'), you MUST keep that qualifier. Never rewrite it as an exact price. Use: 'starts at $X' / 'from $X'."
      : "REGLA: Si un precio está descrito como 'DESDE' (o 'from/starting at'), DEBES mantener ese calificativo. Nunca lo conviertas en precio exacto. Usa: 'desde $X'.";

  const NO_PRICE_INVENTION_RULE =
    idiomaDestino === "en"
      ? "RULE: Do not invent exact prices. Only mention prices if explicitly present in the provided business info, and preserve ranges/qualifiers."
      : "REGLA: No inventes precios exactos. Solo menciona precios si están explícitos en la info del negocio, y preserva rangos/calificativos (DESDE).";

  const PRICE_LIST_FORMAT_RULE =
      isPriceQuestionUser
        ? (
            idiomaDestino === "en"
              ? "RULE: When the user asks about prices or plans and you use SYSTEM_STRUCTURED_DATA, format the pricing options as a short bullet list. Start with one short intro line like 'Here are the main prices:' and then one line per option, e.g. '• Gold Plan – $X/month – short benefit'. Do NOT write long paragraphs and show at most 4–5 bullets."
              : "REGLA: Cuando el usuario pregunte por precios o planes y uses DATOS_ESTRUCTURADOS_DEL_SISTEMA, presenta las opciones como una lista con viñetas. Empieza con una línea corta como 'Aquí tienes los precios principales:' y luego una línea por opción, por ejemplo: '• Plan Gold – $X/mes – beneficio breve'. NO escribas párrafos largos y muestra como máximo 4–5 viñetas."
          )
        : "";

  // 🚫 PROMPT-ONLY fallback
  const fallbackWelcome = await getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

  const composed = await answerWithPromptBase({
    tenantId,
    promptBase: [
      promptBaseMem,
      "",
      NO_NUMERIC_MENUS,
      LIST_FOLLOWUP_RULE,
      PRICE_QUALIFIER_RULE,
      NO_PRICE_INVENTION_RULE,
      PRICE_LIST_FORMAT_RULE,
    ].join("\n"),
    userInput: ["USER_MESSAGE:", eventUserInput].join("\n"),
    history,
    idiomaDestino,
    canal: "whatsapp",
    maxLines: MAX_LINES,
    fallbackText: fallbackWelcome,
  });

  const textOut = String(composed.text || "").trim();

  // detector GENÉRICO yes/no (no industria)
  const looksYesNoQuestion =
    /\?\s*$/.test(textOut) &&
    (
      /\b(te gustar[ií]a|quieres|deseas)\b/i.test(textOut) ||
      /\b(would you like|do you want)\b/i.test(textOut)
    );

  if (looksYesNoQuestion) {
    const { setAwaitingState } = await import("../../../awaiting/setAwaitingState");
    await setAwaitingState(pool, {
      tenantId,
      canal,
      senderId: contactoNorm,
      field: "yes_no",
      payload: { kind: "confirm_generic", source: "llm" },
      ttlSeconds: 600,
    });
  }

  await replyAndExit(
    composed.text,
    smResult.replySource || "state_machine",
    smResult.intent || null
  );

  return true;
}