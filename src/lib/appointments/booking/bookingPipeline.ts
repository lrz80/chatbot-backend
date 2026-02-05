// backend/src/lib/appointments/booking/bookingPipeline.ts
import type poolType from "../../db";
import { bookingFlowMvp } from "../bookingFlow";
import { runBookingGuardrail } from "./guardrail";

// helper local: extrae LINK_RESERVA del prompt base (sin adivinar)
function extractBookingLinkFromPrompt(promptBase: string): string | null {
  if (!promptBase) return null;

  const tagged = promptBase.match(/LINK_RESERVA:\s*(https?:\/\/\S+)/i);
  if (tagged?.[1]) return tagged[1].replace(/[),.]+$/g, "");

  return null;
}

export type BookingPipelineDeps = {
  pool: typeof poolType;

  tenantId: string;
  canal: "whatsapp" | "facebook" | "instagram"; // aquí usas whatsapp hoy
  contacto: string;
  idioma: "es" | "en";
  userText: string;

  messageId: string | null;

  // estado del hilo
  ctx: any;
  transition: (args: { patchCtx?: any; flow?: string; step?: string }) => void;

  // persist del conversation_state
  persistState: (ctx: any) => Promise<void>;

  // booking toggle (leído afuera)
  bookingEnabled: boolean;

  // promptBase para sacar link
  promptBase: string;

  // intent detectado (para guardrail)
  detectedIntent: string | null;

  // Modo de ejecución: "gate" (antes del SM) o "guardrail" (antes del LLM)
  mode: "gate" | "guardrail";

  // Para logs
  sourceTag?: string;
};

export type BookingPipelineResult =
  | { handled: false; ctx: any; bookingLink: string | null }
  | { handled: true; ctx: any; reply: string; intent: "agendar_cita"; source: string; bookingLink: string | null };

export async function runBookingPipeline(deps: BookingPipelineDeps): Promise<BookingPipelineResult> {
  const {
    tenantId,
    canal,
    contacto,
    idioma,
    userText,
    messageId,
    ctx,
    transition,
    persistState,
    bookingEnabled,
    promptBase,
    detectedIntent,
    mode,
    sourceTag,
  } = deps;

  const bookingLink = extractBookingLinkFromPrompt(promptBase);

  // Si booking está OFF: limpia booking del ctx y persiste
  if (!bookingEnabled) {
    if (ctx?.booking) {
      const next = { ...(ctx || {}), booking: null };
      transition({ patchCtx: { booking: null } });
      await persistState(next);
      return { handled: false, ctx: next, bookingLink };
    }
    return { handled: false, ctx, bookingLink };
  }

  // =========================
  // MODE = GATE (ANTES SM/LLM)
  // =========================
  if (mode === "gate") {
    const bk = await bookingFlowMvp({
      tenantId,
      canal,
      contacto,
      idioma,
      userText,
      ctx,
      bookingLink,
      messageId: messageId || undefined,
    });

    if (bk?.ctxPatch) transition({ patchCtx: bk.ctxPatch });

    // recomputa ctx "efectivo" (caller mantiene convoCtx con transition; aquí devolvemos un best-effort)
    const nextCtx = bk?.ctxPatch ? { ...(ctx || {}), ...(bk.ctxPatch || {}) } : ctx;

    if (bk?.handled) {
      await persistState(nextCtx);

      return {
        handled: true,
        ctx: nextCtx,
        reply: bk.reply || (idioma === "en" ? "Ok." : "Perfecto."),
        intent: "agendar_cita",
        source: `booking_flow${sourceTag ? ":" + sourceTag : ""}`,
        bookingLink,
      };
    }

    return { handled: false, ctx: nextCtx, bookingLink };
  }

  // =========================
  // MODE = GUARDRAIL (ANTES LLM)
  // =========================
  const gr = await runBookingGuardrail({
    bookingEnabled,
    bookingLink,
    tenantId,
    canal,
    contacto,
    idioma,
    userText,
    ctx,
    messageId: messageId || undefined,
    detectedIntent: detectedIntent || null,
    bookingFlow: bookingFlowMvp, // DI
  });

  if (gr?.result?.ctxPatch) transition({ patchCtx: gr.result.ctxPatch });

  const nextCtx = gr?.result?.ctxPatch ? { ...(ctx || {}), ...(gr.result.ctxPatch || {}) } : ctx;

  if (gr.hit && gr.result?.handled) {
    await persistState(nextCtx);

    return {
      handled: true,
      ctx: nextCtx,
      reply: gr.result.reply || (idioma === "en" ? "Ok." : "Perfecto."),
      intent: "agendar_cita",
      source: `booking_guardrail${sourceTag ? ":" + sourceTag : ""}`,
      bookingLink,
    };
  }

  return { handled: false, ctx: nextCtx, bookingLink };
}
