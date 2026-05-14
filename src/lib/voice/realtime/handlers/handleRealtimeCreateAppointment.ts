//src/lib/voice/realtime/handlers/handleRealtimeCreateAppointment.ts
import pool from "../../../db";
import { createAppointmentFromVoice } from "../../../appointments/createAppointmentFromVoice";
import { executeCanonicalBookingSlotBusyRecovery } from "../../voiceBookingBusyRecovery";
import { upsertVoiceCallState } from "../../upsertVoiceCallState";
import type { CallState, VoiceLocale } from "../../types";
import {
  clean,
  getConfirmationLikeStep,
  getStepIndexByKey,
  sortFlowSteps,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  buildCanonicalCallState,
  parseJsonStringArray,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";

type RealtimeBookingContext = {
  tenant: any;
  cfg: any;
  callSid: string;
  didNumber: string;
  currentLocale: VoiceLocale;
  state: CallState;
  userInput: string;
  digits: string;
};

type RealtimeMappedStep = {
  step_key: string;
  step_order: number;
  slot: string;
  prompt: string;
  expected_type: string;
  required: boolean;
  retry_prompt: string;
  validation_config: Record<string, unknown> | null;
  prompt_translations: Record<string, unknown> | null;
  retry_prompt_translations: Record<string, unknown> | null;
};

type HandleRealtimeCreateAppointmentParams = {
  tenantId: string;
  callerPhone: string | null;
  args: Record<string, any>;
  bookingContext: RealtimeBookingContext;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
  buildNextRequiredStep: (params: {
    steps: BookingFlowStepLike[];
    bookingState: BookingState;
    locale?: VoiceLocale;
    overridePrompt?: string;
  }) => RealtimeMappedStep | null;
};

function buildRealtimeBookingSmsPayload(params: {
  tenant: any;
  answersBySlot: Record<string, unknown>;
  appointment: any;
  fallbackPhone: string | null;
}): string {
  const businessName = clean(params.tenant?.name);

  const businessPhone =
    clean(params.tenant?.telefono_negocio) ||
    clean(params.tenant?.twilio_voice_number) ||
    clean(params.tenant?.twilio_sms_number) ||
    clean(params.fallbackPhone);

  const service =
    clean(params.answersBySlot.service) ||
    clean(params.answersBySlot.requested_service);

  const datetime =
    clean(params.answersBySlot.datetime_display) ||
    clean(params.answersBySlot.datetime) ||
    clean(params.answersBySlot.datetime_iso);

  const customerName =
    clean(params.answersBySlot.customer_name) ||
    clean(params.answersBySlot.name);

  const googleCalendarLink =
    clean(params.appointment?.google_event_link) ||
    clean(params.appointment?.google_calendar_link);

  return JSON.stringify({
    business_name: businessName,
    business_phone: businessPhone,
    service,
    datetime,
    customer_name: customerName,
    google_calendar_link: googleCalendarLink,
  });
}

export async function handleRealtimeCreateAppointment(
  params: HandleRealtimeCreateAppointmentParams
): Promise<any> {
  const {
    tenantId,
    callerPhone,
    bookingContext,
    steps,
    buildRealtimeBookingState,
    buildNextRequiredStep,
  } = params;

  const confirmationStep = getConfirmationLikeStep(steps);

  if (!confirmationStep) {
    return {
      ok: false,
      error: "BOOKING_CONFIRMATION_STEP_NOT_FOUND",
      message: "No confirmation step is configured in the booking flow.",
    };
  }

  const currentIndex = getStepIndexByKey(
    steps,
    clean(confirmationStep.step_key)
  );

  const confirmationStepKey = clean(confirmationStep.step_key);
  const confirmationSlot = clean(
    typeof confirmationStep.validation_config?.slot === "string"
      ? confirmationStep.validation_config.slot
      : ""
  );

  const existingBookingData = bookingContext.state.bookingData || {};

  const storedConfirmationValue =
    clean(existingBookingData[confirmationStepKey]) ||
    clean(
      confirmationSlot && confirmationSlot !== "none"
        ? existingBookingData[confirmationSlot]
        : ""
    );

  if (!storedConfirmationValue) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: bookingContext.state,
      explicitCurrentIndex: currentIndex >= 0 ? currentIndex : null,
    });

    return {
      ok: false,
      error: "MISSING_FINAL_CONFIRMATION",
      message:
        "Final confirmation has not been submitted through the booking flow.",
      booking_state: bookingState,
      next_required_step: buildNextRequiredStep({
        steps,
        bookingState,
        locale: bookingContext.currentLocale,
      }),
    };
  }

  const answersBySlot = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: buildAnswersBySlot({
        args: {},
        callerPhone,
        state: bookingContext.state,
    }),
    });

    const settingsResult = await pool.query(
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
    [tenantId]
    );

    const settingsRow = settingsResult.rows[0];

    if (!settingsRow) {
    return {
        ok: false,
        error: "APPOINTMENT_SETTINGS_NOT_FOUND",
        message: "Appointment settings are not configured for this tenant.",
        booking_state: buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: currentIndex >= 0 ? currentIndex : null,
        }),
        next_required_step: buildNextRequiredStep({
        steps,
        bookingState: buildRealtimeBookingState({
            steps,
            state: bookingContext.state,
            explicitCurrentIndex: currentIndex >= 0 ? currentIndex : null,
        }),
        locale: bookingContext.currentLocale,
        }),
    };
    }

    const stepKeyToSlot = Object.fromEntries(
      steps
        .map((step) => {
          const stepKey = clean(step.step_key);
          const slot = clean(
            typeof step.validation_config?.slot === "string"
            ? step.validation_config.slot
            : ""
          );

          return stepKey && slot && slot !== "none" ? [stepKey, slot] : null;
        })
        .filter((entry): entry is [string, string] => Array.isArray(entry))
    );

    try {
    const appointment = await createAppointmentFromVoice({
        tenantId,
        answersBySlot,
        stepKeyToSlot,
        settings: {
        default_duration_min: Number(settingsRow.default_duration_min || 0),
        buffer_min: Number(settingsRow.buffer_min || 0),
        min_lead_minutes: Number(settingsRow.min_lead_minutes || 0),
        timezone: clean(settingsRow.timezone) || "America/New_York",
        enabled: settingsRow.enabled !== false,
        },
    });

    const bookingSmsPayload = buildRealtimeBookingSmsPayload({
      tenant: bookingContext.tenant,
      answersBySlot,
      appointment,
      fallbackPhone: bookingContext.didNumber,
    });

    const baseCreatedState: CallState = {
      ...bookingContext.state,
      bookingData: {
        ...(bookingContext.state.bookingData || {}),
        ...answersBySlot,
        appointment_id: clean(appointment.id),
        external_calendar_event_id: clean(appointment.external_calendar_event_id),
        google_event_id: clean(appointment.google_event_id),
        google_event_link: clean(appointment.google_event_link),
        booking_sms_payload: bookingSmsPayload,
      },
    };

    const successIndex =
      currentIndex + 1 < steps.length ? currentIndex + 1 : null;

        const successBookingState =
      successIndex === null
        ? null
        : buildRealtimeBookingState({
            steps,
            state: baseCreatedState,
            explicitCurrentIndex: successIndex,
          });

    const successStep =
      successBookingState === null
        ? null
        : buildNextRequiredStep({
            steps,
            bookingState: successBookingState,
            locale: bookingContext.currentLocale,
          });

    const successIsInformational =
      successStep &&
      successStep.required !== true &&
      clean(successStep.slot) === "none" &&
      clean(successStep.expected_type) !== "confirmation";

    const nextIndex = successIsInformational
      ? successIndex !== null && successIndex + 1 < steps.length
        ? successIndex + 1
        : null
      : successIndex;

    const createdState: CallState = {
      ...baseCreatedState,
      bookingStepIndex:
        typeof nextIndex === "number" ? nextIndex : undefined,
    };

    Object.assign(bookingContext.state, createdState);

    await upsertVoiceCallState({
      callSid: bookingContext.callSid,
      tenantId,
      lang: createdState.lang ?? bookingContext.currentLocale,
      turn: createdState.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: createdState.altDest ?? null,
      smsSent: createdState.smsSent ?? false,
      bookingStepIndex:
        typeof nextIndex === "number" ? nextIndex : null,
      bookingData: createdState.bookingData || {},
    });

    const nextBookingState =
      nextIndex === null
        ? {
            current_step_key: null,
            current_step_slot: null,
            awaiting_confirmation: false,
            final_confirmation_granted: true,
            ready_to_create: false,
            collected_slots: answersBySlot,
          }
        : buildRealtimeBookingState({
            steps,
            state: createdState,
            explicitCurrentIndex: nextIndex,
            finalConfirmationGranted: true,
            readyToCreate: false,
          });

    const nextRequiredStep =
      nextIndex === null
        ? null
        : buildNextRequiredStep({
            steps,
            bookingState: nextBookingState,
            locale: bookingContext.currentLocale,
          });

    return {
        ok: true,
        message: clean(successStep?.prompt || ""),
        assistant_prompt: [clean(successStep?.prompt || ""), clean(nextRequiredStep?.prompt || "")]
        .filter(Boolean)
        .join(" "),
        booking_outcome: "confirmed",
        booking_state: nextBookingState,
        next_required_step: nextRequiredStep,
    };
    } catch (error) {
    const err = error as Error & {
        error?: string;
        suggestedStarts?: string[];
    };

    if (err.error === "SLOT_BUSY" || err.message.startsWith("SLOT_BUSY:")) {
        const busyRecovered = await executeCanonicalBookingSlotBusyRecovery({
        flow: steps as any,
        state: bookingContext.state,
        tenantId,
        callSid: bookingContext.callSid,
        currentLocale: bookingContext.currentLocale,
        callerE164: callerPhone,
        timeZone: clean(settingsRow.timezone) || "America/New_York",
        suggestedStarts: Array.isArray(err.suggestedStarts)
            ? err.suggestedStarts
            : [],
        });

        Object.assign(bookingContext.state, busyRecovered.state);

        const bookingState = buildRealtimeBookingState({
        steps,
        state: busyRecovered.state,
        explicitCurrentIndex: busyRecovered.datetimeStepIndex,
        });

        return {
        ok: false,
        error: "SLOT_UNAVAILABLE",
        message: busyRecovered.prompt,
        assistant_prompt: busyRecovered.prompt,
        suggested_times: parseJsonStringArray(
            busyRecovered.state.bookingData?.__booking_busy_suggested_starts
        ),
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
            steps,
            bookingState,
            locale: bookingContext.currentLocale,
            overridePrompt: busyRecovered.prompt,
        }),
        };
    }

    return {
        ok: false,
        error: "BOOKING_FAILED",
        message: err.message,
        assistant_prompt: "",
        booking_outcome: "failed",
        booking_state: buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: null,
        }),
        next_required_step: null,
    };
  }
}