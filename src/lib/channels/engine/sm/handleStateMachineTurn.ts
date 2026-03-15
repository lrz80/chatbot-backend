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
import { resolveServiceIdFromText } from "../../../services/pricing/resolveServiceIdFromText";

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
  // 🚫 NO dejar que SM secuestre turnos sin estado activo real
  // ===============================
  const smIntent = String(smResult.intent || "").trim().toLowerCase();
  const smReplySource = String(smResult.replySource || "").trim().toLowerCase();

  const SM_REPLY_REQUIRES_ACTIVE_STATE = new Set([
    "pago",
    "datos_cliente",
    "booking",
    "reserva",
    "checkout",
  ]);

  const looksStatefulReply =
    SM_REPLY_REQUIRES_ACTIVE_STATE.has(smIntent) ||
    smReplySource.startsWith("pago") ||
    smReplySource.startsWith("booking") ||
    smReplySource.startsWith("checkout");

  const hasActiveTransition =
    !!smResult?.transition &&
    (
      !!smResult.transition.nextState ||
      !!smResult.transition.state ||
      !!smResult.transition.effects?.length
    );

  if (looksStatefulReply && !hasActiveTransition) {
    console.log("[SM][SKIP_REPLY_NO_ACTIVE_STATE]", {
      tenantId,
      canal,
      contactoNorm,
      userInput: eventUserInput,
      smIntent,
      smReplySource,
      hasActiveTransition,
    });
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
          "- If the user also asks about schedules/hours, answer hours in 1 short sentence and then show the prices as a bullet list.",
        ].join(" ")
      : [
          "REGLA: Si tu respuesta menciona precios o planes tomados de DATOS_ESTRUCTURADOS_DEL_SISTEMA, DEBES formatearlos como lista con viñetas.",
          "- Puedes empezar con 0–1 línea muy corta de introducción (por ejemplo: 'Los precios principales son:').",
          "- Luego usa UNA línea por opción, por ejemplo: '• Plan Gold Autopay: $165.99/mes – beneficio breve'.",
          "- NUNCA metas varios precios o planes distintos en un solo párrafo largo.",
          "- Si el usuario también pregunta por horarios, responde los horarios en 1 frase corta y después muestra los precios como lista con viñetas.",
        ].join(" ");

  // 🚫 PROMPT-ONLY fallback
  // ❌ antes estaba hardcodeado a "whatsapp"
  const fallbackWelcome = await getBienvenidaPorCanal(canal, tenant, idiomaDestino);

  const resolvedEntityId = null;
  const resolvedEntityLabel = null;
  const hasResolvedEntity = false;

  let serviceRecommendationBlock = "";

  const canRecommendFromDb =
    (smResult.intent || null) === "info_servicio" && !hasResolvedEntity;

  if (canRecommendFromDb) {
    const { rows } = await pool.query<{
      service_id: string;
      service_name: string | null;
      service_description: string | null;
      variant_name: string | null;
      variant_description: string | null;
    }>(
      `
      SELECT
        s.id AS service_id,
        s.name AS service_name,
        s.description AS service_description,
        v.variant_name,
        v.description AS variant_description
      FROM services s
      LEFT JOIN service_variants v
        ON v.service_id = s.id
       AND v.active = true
      WHERE
        s.tenant_id = $1
        AND s.active = true
        AND s.name IS NOT NULL
      ORDER BY s.created_at ASC, v.created_at ASC NULLS LAST, v.id ASC NULLS LAST
      `,
      [tenantId]
    );

    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        snippets: string[];
      }
    >();

    for (const r of rows) {
      const id = String(r.service_id || "").trim();
      const name = String(r.service_name || "").trim();
      if (!id || !name) continue;

      let entry = grouped.get(id);
      if (!entry) {
        entry = { id, name, snippets: [] };
        grouped.set(id, entry);
      }

      const parts = [
        String(r.service_description || "").trim(),
        String(r.variant_name || "").trim(),
        String(r.variant_description || "").trim(),
      ].filter(Boolean);

      for (const p of parts) {
        if (!entry.snippets.includes(p)) entry.snippets.push(p);
      }
    }

    const serviceCandidates = Array.from(grouped.values()).slice(0, 8);

    serviceRecommendationBlock =
      idiomaDestino === "en"
        ? [
            "SYSTEM_STRUCTURED_SERVICE_CANDIDATES:",
            ...serviceCandidates.map((s, idx) => {
              const extra = s.snippets.slice(0, 2).join(" | ");
              return `${idx + 1}. ${s.name}${extra ? ` — ${extra}` : ""}`;
            }),
            "",
            "RULE:",
            "- If you recommend a service, you MUST recommend ONLY from the candidate list above.",
            "- Do NOT invent service names.",
            "- Do NOT merge or rename services.",
            "- If the list is insufficient or ambiguous, ask one short clarification question instead of inventing.",
          ].join("\n")
        : [
            "CANDIDATOS_DE_SERVICIO_ESTRUCTURADOS_DEL_SISTEMA:",
            ...serviceCandidates.map((s, idx) => {
              const extra = s.snippets.slice(0, 2).join(" | ");
              return `${idx + 1}. ${s.name}${extra ? ` — ${extra}` : ""}`;
            }),
            "",
            "REGLA:",
            "- Si recomiendas un servicio, DEBES recomendar SOLO uno de la lista de candidatos anterior.",
            "- No inventes nombres de servicios.",
            "- No mezcles ni renombres servicios.",
            "- Si la lista no alcanza o hay ambigüedad, haz una sola pregunta corta de aclaración en vez de inventar.",
          ].join("\n");

    console.log("[SM][DB_SERVICE_CANDIDATES_FOR_LLM]", {
      tenantId,
      canal,
      userInput: eventUserInput,
      candidates: serviceCandidates.map((s) => s.name),
    });
  }

  console.log("[SM][ANSWER_WITH_PROMPT_BASE][POLICY]", {
    tenantId,
    canal,
    userInput: eventUserInput,
    resolvedEntityId,
    resolvedEntityLabel,
    hasResolvedEntity,
    smAction: smResult.action,
    smIntent: smResult.intent ?? null,
    smReplySource: smResult.replySource ?? null,
  });

  const composed = await answerWithPromptBase({
    tenantId,
    promptBase: [
      promptBaseMem,
      "",
      serviceRecommendationBlock,
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
    canal,
    maxLines: MAX_LINES,
    fallbackText: fallbackWelcome,

    responsePolicy: {
      mode: "clarify_only",
      resolvedEntityType: null,
      resolvedEntityId,
      resolvedEntityLabel,
      canMentionSpecificPrice: false,
      canSelectSpecificCatalogItem: false,
      canOfferBookingTimes: false,
      canUseCatalogLists: false,
      canUseOfficialLinks: true,
      unresolvedEntity: true,
      clarificationTarget: "service",
      reasoningNotes: "state_machine_reply_without_structured_resolution",
    },
  });

  const textOut = String(composed.text || "").trim();

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