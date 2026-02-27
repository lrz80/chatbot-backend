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
import { parseDatosCliente } from "../../../../lib/parseDatosCliente";

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

  parseDatosCliente: typeof parseDatosCliente;
  extractPaymentLinkFromPrompt?: ((text: string) => string | null) | null;
  PAGO_CONFIRM_REGEX?: RegExp | null;
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
    parseDatosCliente,
    extractPaymentLinkFromPrompt = null,
    PAGO_CONFIRM_REGEX = null,
  } = args;

  const loweredInput = (userInput || "").toLowerCase();

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
  promptBase,

  // ✅ PASA LA FUNCIÓN REAL
  parseDatosCliente,

  // ✅ Stub seguro: siempre devuelve null → no rompe paymentHumanGuard
  extractPaymentLinkFromPrompt: (text: string) => null,

  // ✅ De momento sin regex de confirmación de pago
  PAGO_CONFIRM_REGEX: null,
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