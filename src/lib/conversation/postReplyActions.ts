// backend/src/lib/conversation/postReplyActions.ts
import type poolType from "../db";
import { esIntencionDeVenta } from "../detectarIntencion";
import { recordSalesIntent } from "../sales/recordSalesIntent";
import {
  capiContactQualified,
  capiLeadStrongWeekly,
} from "../analytics/capiEvents";
import { scheduleFollowUpIfEligible } from "../followups/followUpScheduler";

type Canal = "whatsapp" | "facebook" | "instagram" | string;

export async function runPostReplyActions(opts: {
  pool: typeof poolType;

  tenant: any;
  tenantId: string;
  canal: Canal;

  contactoNorm: string;
  fromNumber?: string | null;
  messageId?: string | null;
  userInput: string;

  idiomaDestino: "es" | "en";

  lastIntent?: string | null;
  intentFallback?: string | null;

  detectedInterest?: number | null;

  convoCtx?: any;
}) {
  const {
    pool,
    tenant,
    tenantId,
    canal,
    contactoNorm,
    fromNumber,
    messageId,
    userInput,
    idiomaDestino,
    lastIntent,
    intentFallback,
    detectedInterest,
    convoCtx,
  } = opts;

  // Solo si hay messageId (para dedupe/trace)
  if (!messageId) return;

  const finalIntent = (lastIntent || intentFallback || "")
    .toString()
    .trim()
    .toLowerCase();

  const finalNivel =
    typeof detectedInterest === "number"
      ? Math.min(3, Math.max(1, detectedInterest))
      : 2;

  // -----------------------
  // 1) Guardar intención de venta (DB)
  // -----------------------
  try {
    if (finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 2) {
      await recordSalesIntent({
        tenantId,
        contacto: contactoNorm,
        canal,
        mensaje: userInput,
        intencion: finalIntent,
        nivelInteres: finalNivel,
        messageId,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ recordSalesIntent failed:", e?.message);
  }

  // -----------------------
  // 2) META CAPI — Contact Qualified (evento #2)
  // -----------------------
  try {
    if (finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 2) {
      await capiContactQualified({
        pool,
        tenantId,
        canal: canal as any,
        contactoNorm,
        fromNumber: fromNumber || null,
        messageId,
        finalIntent,
        finalNivel,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ capiContactQualified failed:", e?.message);
  }

  // -----------------------
  // 3) META CAPI — Lead fuerte semanal (evento #3)
  // -----------------------
  try {
    if (finalIntent && esIntencionDeVenta(finalIntent) && finalNivel >= 3) {
      await capiLeadStrongWeekly({
        pool,
        tenantId,
        canal: canal as any,
        contactoNorm,
        fromNumber: fromNumber || null,
        messageId,
        finalIntent,
        finalNivel,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ capiLeadStrongWeekly failed:", e?.message);
  }

  // -----------------------
  // 4) Follow-up scheduler
  // -----------------------
  try {
    const bookingStep = (convoCtx as any)?.booking?.step;
    const inBooking = bookingStep && bookingStep !== "idle";

    const bookingJustCompleted = !!(convoCtx as any)?.booking_completed;

    const skipFollowUp =
      inBooking ||
      bookingJustCompleted ||
      finalIntent === "agendar_cita";

    await scheduleFollowUpIfEligible({
      tenant,
      canal: canal as any,
      contactoNorm,
      idiomaDestino,
      intFinal: finalIntent || null,
      nivel: finalNivel,
      userText: userInput,
      skip: skipFollowUp,
    });
  } catch (e: any) {
    console.warn("⚠️ scheduleFollowUpIfEligible failed:", e?.message);
  }
}
