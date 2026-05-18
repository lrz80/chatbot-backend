//src/lib/voice/booking/confirmation/createConfirmedVoiceAppointment.ts
import pool from "../../../db";
import { createAppointmentFromVoice } from "../../../appointments/createAppointmentFromVoice";
import {
  buildAnswersBySlot,
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingSuccessStep,
} from "../../voiceBookingHelpers";
import { twoSentencesMax } from "../../speechFormatting";
import {
  assertNonEmptyBookingSpeech,
  buildExtraBookingFields,
} from "../bookingSpeech";
import type { BookingFlow } from "../types";
import type { CallState, VoiceLocale } from "../../types";

export type ConfirmedVoiceAppointmentResult = {
  bookingTimeZone: string;
  successStepIndex: number;
  successPrompt: string;
  smsOfferPrompt: string | null;
  bookingSmsPayloadJson: string;
  bookingSpeechData: Record<string, string>;
};

export async function createConfirmedVoiceAppointment(params: {
  tenant: any;
  cfg: any;
  flow: BookingFlow;
  currentLocale: VoiceLocale;
  callSid: string;
  callerE164: string | null;
  state: CallState;
}): Promise<ConfirmedVoiceAppointmentResult> {
  const { tenant, cfg, flow, currentLocale, callSid, callerE164, state } =
    params;

  let bookingTimeZone = "America/New_York";

  try {
    const { rows: settingsRows } = await pool.query(
      `
      SELECT
        default_duration_min,
        buffer_min,
        min_lead_minutes,
        timezone,
        enabled
      FROM appointment_settings
      WHERE tenant_id = $1
      LIMIT 1
      `,
      [tenant.id]
    );

    const appointmentSettings = settingsRows[0] || {
      default_duration_min: 30,
      buffer_min: 10,
      min_lead_minutes: 60,
      timezone: "America/New_York",
      enabled: true,
    };

    bookingTimeZone =
      String(appointmentSettings?.timezone || "").trim() || bookingTimeZone;

    const rawBookingData = state.bookingData || {};

    const answersBySlotBase = buildAnswersBySlot({
      flow,
      bookingData: rawBookingData,
    });

    const answersBySlot: Record<string, string | null | undefined> = {
      ...answersBySlotBase,
    };

    if (
      typeof rawBookingData.datetime_iso === "string" &&
      rawBookingData.datetime_iso.trim()
    ) {
      answersBySlot.datetime_iso = rawBookingData.datetime_iso.trim();
    }

    if (
      typeof rawBookingData.datetime_display === "string" &&
      rawBookingData.datetime_display.trim()
    ) {
      answersBySlot.datetime_display = rawBookingData.datetime_display.trim();
    }

    const appointment = await createAppointmentFromVoice({
      tenantId: tenant.id,
      answersBySlot,
      idempotencyKey: `voice:${callSid}`,
      settings: appointmentSettings,
    });

    const appointmentRecord = appointment as any;

    const successStep = resolveBookingSuccessStep({ flow });

    if (!successStep) {
      throw new Error("BOOKING_SUCCESS_STEP_NOT_CONFIGURED");
    }

    const successStepIndex = flow.findIndex(
      (step) => step.step_key === successStep.step_key
    );

    if (successStepIndex === -1) {
      throw new Error("BOOKING_SUCCESS_STEP_INDEX_NOT_FOUND");
    }

    const extraFields = buildExtraBookingFields(state.bookingData || {});

    const bookingSmsPayload = {
      business_name: String(tenant?.name || "").trim(),
      business_phone: String(
        cfg?.representante_number ||
          tenant?.twilio_voice_number ||
          tenant?.twilio_sms_number ||
          ""
      ).trim(),
      service: String(
        state.bookingData?.service_display || state.bookingData?.service || ""
      ).trim(),
      datetime: String(
        state.bookingData?.datetime_display ||
          state.bookingData?.datetime ||
          ""
      ).trim(),
      customer_name: String(
        state.bookingData?.customer_name || state.bookingData?.name || ""
      ).trim(),
      google_calendar_link: String(
        appointmentRecord?.google_event_link ||
          appointmentRecord?.googleEventLink ||
          appointmentRecord?.html_link ||
          appointmentRecord?.htmlLink ||
          appointmentRecord?.google_event_url ||
          appointmentRecord?.event_link ||
          ""
      ).trim(),
      extra_fields: extraFields,
    };

    const bookingSmsPayloadJson = JSON.stringify(bookingSmsPayload);

    const bookingSpeechData: Record<string, string> = {
      ...(state.bookingData || {}),
      service:
        state.bookingData?.service_display || state.bookingData?.service || "",
      datetime:
        state.bookingData?.datetime_display ||
        state.bookingData?.datetime ||
        "",
      datetime_display:
        state.bookingData?.datetime_display ||
        state.bookingData?.datetime ||
        "",
      datetime_iso:
        typeof state.bookingData?.datetime_iso === "string"
          ? state.bookingData.datetime_iso
          : "",
    };

    const successPromptText = resolveBookingPromptText({
      locale: currentLocale,
      prompt: successStep.prompt || "",
      promptTranslations: successStep.prompt_translations || null,
    });

    const successPromptResolved = resolveBookingFlowSpeech({
      baseText: successPromptText,
      locale: currentLocale,
      bookingData: bookingSpeechData,
      callerE164,
    });

    const successPrompt = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: successPromptResolved,
        stepKey: successStep.step_key,
        field: "prompt",
      })
    );

    const nextStepAfterSuccess = flow[successStepIndex + 1];

    if (
      nextStepAfterSuccess &&
      nextStepAfterSuccess.step_key === "offer_booking_sms"
    ) {
      const nextPromptText = resolveBookingPromptText({
        locale: currentLocale,
        prompt: nextStepAfterSuccess.prompt || "",
        promptTranslations: nextStepAfterSuccess.prompt_translations || null,
      });

      const nextPromptResolved = resolveBookingFlowSpeech({
        baseText: nextPromptText,
        locale: currentLocale,
        bookingData: bookingSpeechData,
        callerE164,
      });

      const smsOfferPrompt = twoSentencesMax(
        assertNonEmptyBookingSpeech({
          text: nextPromptResolved,
          stepKey: nextStepAfterSuccess.step_key,
          field: "prompt",
        })
      );

      return {
        bookingTimeZone,
        successStepIndex,
        successPrompt,
        smsOfferPrompt,
        bookingSmsPayloadJson,
        bookingSpeechData,
      };
    }

    return {
      bookingTimeZone,
      successStepIndex,
      successPrompt,
      smsOfferPrompt: null,
      bookingSmsPayloadJson,
      bookingSpeechData,
    };
  } catch (err: any) {
    if (err && typeof err === "object") {
      err.bookingTimeZone = bookingTimeZone;
    }

    throw err;
  }
}