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
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  parseJsonStringArray,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { resolvePostCreateBookingTransition } from "../bookingStep/resolvePostCreateBookingTransition";

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
      const bookingState = buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: null,
        finalConfirmationGranted: true,
        readyToCreate: false,
      });

      const createFailedPromptTranslations =
        typeof bookingContext.cfg?.appointment_create_failed_prompt_translations ===
          "object" &&
        bookingContext.cfg?.appointment_create_failed_prompt_translations !== null
          ? bookingContext.cfg.appointment_create_failed_prompt_translations
          : {};

      const configuredPrompt =
        clean(createFailedPromptTranslations[bookingContext.currentLocale]) ||
        clean(bookingContext.cfg?.appointment_create_failed_prompt);

      return {
        ok: false,
        error: "APPOINTMENT_SETTINGS_NOT_FOUND",
        message: "Appointment settings are not configured for this tenant.",
        assistant_prompt: configuredPrompt,
        booking_outcome: "failed_configuration",
        customer_action_required: true,
        action_required: null,
        booking_state: bookingState,
        next_required_step: null,
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

    const postCreateTransition = resolvePostCreateBookingTransition({
      steps,
      confirmationStepKey,
    });

    const informationalBookingState =
      postCreateTransition.informationalStepIndex === null
        ? null
        : buildRealtimeBookingState({
            steps,
            state: baseCreatedState,
            explicitCurrentIndex: postCreateTransition.informationalStepIndex,
            finalConfirmationGranted: true,
            readyToCreate: false,
          });

    const informationalStep =
      informationalBookingState === null
        ? null
        : buildNextRequiredStep({
            steps,
            bookingState: informationalBookingState,
            locale: bookingContext.currentLocale,
          });

    const nextIndex = postCreateTransition.actionableStepIndex;

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
        message: clean(informationalStep?.prompt || ""),
        assistant_prompt: [
          clean(informationalStep?.prompt || ""),
          clean(nextRequiredStep?.prompt || ""),
        ]
          .filter(Boolean)
          .join(" "),
        booking_outcome: nextRequiredStep ? "confirmed_next_action" : "confirmed",
        booking_state: nextBookingState,
        next_required_step: nextRequiredStep,
      };
    } catch (error) {
    const err = error as Error & {
        error?: string;
        suggestedStarts?: string[];
    };

    if (
      err.message === "BOOKING_REQUIRES_DEPOSIT" ||
      (err as any).code === "BOOKING_REQUIRES_DEPOSIT"
    ) {
      const depositAmountCents =
        typeof (err as any).amountCents === "number"
          ? (err as any).amountCents
          : null;

      const depositCurrency = clean((err as any).currency || "USD") || "USD";
      const depositPaymentUrl = clean((err as any).paymentUrl);
      const depositPolicyText = clean((err as any).policyText);
      const depositServiceName =
        clean((err as any).serviceName) || clean(answersBySlot.service);

      const depositState: CallState = {
        ...bookingContext.state,
        bookingData: {
          ...(bookingContext.state.bookingData || {}),
          ...answersBySlot,
          booking_outcome: "requires_deposit",
          deposit_required: "true",
          deposit_service_name: depositServiceName,
          deposit_amount_cents:
            depositAmountCents && depositAmountCents > 0
              ? String(depositAmountCents)
              : "",
          deposit_currency: depositCurrency,
          deposit_payment_url: depositPaymentUrl,
          deposit_policy_text: depositPolicyText,
        },
      };

      Object.assign(bookingContext.state, depositState);

      await upsertVoiceCallState({
        callSid: bookingContext.callSid,
        tenantId,
        lang: depositState.lang ?? bookingContext.currentLocale,
        turn: depositState.turn ?? 0,
        awaiting: false,
        pendingType: null,
        awaitingNumber: false,
        altDest: depositState.altDest ?? null,
        smsSent: depositState.smsSent ?? false,
        bookingStepIndex: null,
        bookingData: depositState.bookingData || {},
      });

      const bookingState = buildRealtimeBookingState({
        steps,
        state: depositState,
        explicitCurrentIndex: null,
        finalConfirmationGranted: true,
        readyToCreate: false,
      });

      return {
        ok: false,
        error: "BOOKING_REQUIRES_DEPOSIT",
        booking_outcome: "requires_deposit",
        customer_action_required: true,
        provider: "square",

        deposit_required: true,
        deposit_service_name: depositServiceName,
        deposit_amount_cents: depositAmountCents,
        deposit_currency: depositCurrency,
        deposit_payment_url: depositPaymentUrl || null,
        deposit_policy_text: depositPolicyText || null,

        /**
         * Important:
         * No user-facing hardcoded copy here.
         * The assistant should speak using configured deposit_policy_text
         * from service mapping metadata or a tenant-level renderer/template.
         */
        message: depositPolicyText,
        assistant_prompt: depositPolicyText,

        booking_state: bookingState,
        next_required_step: null,
      };
    }

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

    if (err.message === "SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED") {
      const bookingState = buildRealtimeBookingState({
        steps,
        state: bookingContext.state,
        explicitCurrentIndex: null,
        finalConfirmationGranted: true,
        readyToCreate: false,
      });

      return {
        ok: false,
        error: "SQUARE_WRITE_OPERATIONS_NOT_SUPPORTED",
        booking_outcome: "requires_customer_action",
        customer_action_required: true,
        fallback_action: "SEND_BOOKING_LINK",
        provider: "square",
        booking_state: bookingState,
        next_required_step: null,
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