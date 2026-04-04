// src/lib/conversation/postReplyActions.ts
import type poolType from "../db";
import type { LangCode } from "../i18n/lang";
import { recordSalesIntent } from "../sales/recordSalesIntent";
import {
  capiContactQualified,
  capiLeadStrongWeekly,
} from "../analytics/capiEvents";
import { scheduleFollowUpIfEligible } from "../followups/followUpScheduler";

type Canal = "whatsapp" | "facebook" | "instagram" | string;

type PurchaseIntentLevel = "unknown" | "low" | "medium" | "high";
type CommercialUrgencyLevel = "unknown" | "low" | "medium" | "high";

type CommercialSignal = {
  purchaseIntent: PurchaseIntentLevel;
  wantsBooking: boolean;
  wantsQuote: boolean;
  wantsHuman: boolean;
  urgency: CommercialUrgencyLevel;
};

function normalizeLevel(value: unknown): PurchaseIntentLevel {
  const normalized = String(value || "").trim().toLowerCase();

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function normalizeUrgency(value: unknown): CommercialUrgencyLevel {
  const normalized = String(value || "").trim().toLowerCase();

  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }

  return "unknown";
}

function normalizeCommercialSignal(
  value?: Partial<CommercialSignal> | null
): CommercialSignal {
  return {
    purchaseIntent: normalizeLevel(value?.purchaseIntent),
    wantsBooking: value?.wantsBooking === true,
    wantsQuote: value?.wantsQuote === true,
    wantsHuman: value?.wantsHuman === true,
    urgency: normalizeUrgency(value?.urgency),
  };
}

function shouldTreatAsSalesLead(input: {
  finalIntent: string;
  finalNivel: number;
  commercial: CommercialSignal;
}): boolean {
  const { finalIntent, finalNivel, commercial } = input;

  if (!finalIntent) return false;

  if (commercial.purchaseIntent === "high") return true;
  if (commercial.purchaseIntent === "medium" && finalNivel >= 2) return true;
  if (commercial.wantsBooking) return true;
  if (commercial.wantsQuote && finalNivel >= 2) return true;

  return false;
}

function shouldTreatAsStrongLead(input: {
  finalNivel: number;
  commercial: CommercialSignal;
}): boolean {
  const { finalNivel, commercial } = input;

  if (commercial.purchaseIntent === "high") return true;
  if (commercial.urgency === "high") return true;
  if (commercial.wantsBooking && finalNivel >= 2) return true;

  return finalNivel >= 3;
}

export async function runPostReplyActions(opts: {
  pool: typeof poolType;

  tenant: any;
  tenantId: string;
  canal: Canal;

  contactoNorm: string;
  fromNumber?: string | null;
  messageId?: string | null;
  userInput: string;

  idiomaDestino: LangCode;

  lastIntent?: string | null;
  intentFallback?: string | null;

  detectedInterest?: number | null;
  detectedCommercial?: Partial<CommercialSignal> | null;

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
    detectedCommercial,
    convoCtx,
  } = opts;

  if (!messageId) return;

  const finalIntent = String(lastIntent || intentFallback || "")
    .trim()
    .toLowerCase();

  const finalNivel =
    typeof detectedInterest === "number"
      ? Math.min(3, Math.max(1, detectedInterest))
      : 2;

  const commercial = normalizeCommercialSignal(detectedCommercial);

  const isSalesLead = shouldTreatAsSalesLead({
    finalIntent,
    finalNivel,
    commercial,
  });

  const isStrongLead = shouldTreatAsStrongLead({
    finalNivel,
    commercial,
  });

  try {
    if (isSalesLead) {
      await recordSalesIntent({
        tenantId,
        contacto: contactoNorm,
        canal,
        mensaje: userInput,
        intencion: finalIntent || "unknown",
        nivelInteres: finalNivel,
        messageId,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ recordSalesIntent failed:", e?.message);
  }

  try {
    if (isSalesLead) {
      await capiContactQualified({
        pool,
        tenantId,
        canal: canal as any,
        contactoNorm,
        fromNumber: fromNumber || null,
        messageId,
        finalIntent: finalIntent || "unknown",
        finalNivel,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ capiContactQualified failed:", e?.message);
  }

  try {
    if (isStrongLead) {
      await capiLeadStrongWeekly({
        pool,
        tenantId,
        canal: canal as any,
        contactoNorm,
        fromNumber: fromNumber || null,
        messageId,
        finalIntent: finalIntent || "unknown",
        finalNivel,
      });
    }
  } catch (e: any) {
    console.warn("⚠️ capiLeadStrongWeekly failed:", e?.message);
  }

  try {
    const bookingStep = (convoCtx as any)?.booking?.step;
    const inBooking = bookingStep && bookingStep !== "idle";

    const bookingJustCompleted = Boolean((convoCtx as any)?.booking_completed);

    const skipFollowUp =
      inBooking ||
      bookingJustCompleted ||
      commercial.wantsBooking;

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