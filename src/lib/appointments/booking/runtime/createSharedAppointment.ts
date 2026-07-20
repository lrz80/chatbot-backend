// src/lib/appointments/booking/runtime/createSharedAppointment.ts

import {
  getAppointmentSettings,
} from "../../getAppointmentSettings";

import {
  createAppointment,
  type AppointmentBookingChannel,
} from "../../createAppointment";

import {
  clean,
  getConfirmationLikeStep,
  getStepSlot,
  normalizeAnswersToCanonicalSlots,
  buildAnswersBySlot,
  sortFlowSteps,
  type BookingFlowStepLike,
  type BookingState,
} from "../../../voice/realtime/realtimeBookingFlowUtils";

import type {
  CallState,
  VoiceLocale,
} from "../../../voice/types";

import {
  getSharedBookingFlow,
} from "../../getBookingFlow";

import {
  buildRealtimeNextRequiredStep,
  type RealtimeMappedStep,
} from "../../../voice/realtime/bookingStep/buildRealtimeNextRequiredStep";

import {
  resolvePostCreateBookingTransition,
} from "../../../voice/realtime/bookingStep/resolvePostCreateBookingTransition";

import {
  buildBookingSlotBusyRecovery,
} from "./buildBookingSlotBusyRecovery";

export type CreateSharedAppointmentParams = {
  tenantId: string;
  channel: Exclude<
    AppointmentBookingChannel,
    "voice"
  >;
  sessionId: string;
  locale: VoiceLocale;
  contactPhone: string | null;
  state: CallState;
};

export type CreateSharedAppointmentResult =
  | {
      ok: true;
      state: CallState;
      appointment: any;
      booking_state: BookingState;
      next_required_step: RealtimeMappedStep | null;
      assistant_prompt: string;
      flow_complete: boolean;
      outcome: "confirmed" | "confirmed_next_action";
    }
  | {
      ok: false;
      error: string;
      state: CallState;
      booking_state: BookingState | null;
      next_required_step: RealtimeMappedStep | null;
      assistant_prompt: string;
      flow_complete: boolean;
      customer_action_required: boolean;
      deposit_payment_url?: string | null;
      suggested_times?: string[];
      details?: Record<string, unknown>;
    };

function buildBookingState(params: {
  steps: BookingFlowStepLike[];
  state: CallState;
  currentIndex: number | null;
  confirmed?: boolean;
}): BookingState {
  const answersBySlot =
    normalizeAnswersToCanonicalSlots({
      steps: params.steps,
      answersBySlot:
        params.state.bookingData || {},
    });

  const currentStep =
    typeof params.currentIndex === "number"
      ? params.steps[params.currentIndex] || null
      : null;

  return {
    current_step_key:
      currentStep
        ? clean(currentStep.step_key) || null
        : null,

    current_step_slot:
      currentStep
        ? getStepSlot(currentStep) || null
        : null,

    awaiting_confirmation: false,

    final_confirmation_granted:
      params.confirmed === true,

    ready_to_create: false,

    collected_slots: answersBySlot,
  };
}

function buildStepKeyToSlot(
  steps: BookingFlowStepLike[]
): Record<string, string> {
  const entries = steps
    .map((step): [string, string] | null => {
      const stepKey = clean(step.step_key);
      const slot = getStepSlot(step);

      if (
        !stepKey ||
        !slot ||
        slot === "none"
      ) {
        return null;
      }

      return [stepKey, slot];
    })
    .filter(
      (
        entry
      ): entry is [string, string] =>
        entry !== null
    );

  return Object.fromEntries(entries);
}

export async function createSharedAppointment(
  params: CreateSharedAppointmentParams
): Promise<CreateSharedAppointmentResult> {
  const steps = sortFlowSteps(
    (await getSharedBookingFlow(
      params.tenantId
    )) as BookingFlowStepLike[]
  );

  if (steps.length === 0) {
    return {
      ok: false,
      error:
        "BOOKING_FLOW_NOT_CONFIGURED",
      state: params.state,
      booking_state: null,
      next_required_step: null,
      assistant_prompt: "",
      flow_complete: true,
      customer_action_required: true,
    };
  }

  const confirmationStep =
    getConfirmationLikeStep(steps);

  if (!confirmationStep) {
    return {
      ok: false,
      error:
        "BOOKING_CONFIRMATION_STEP_NOT_FOUND",
      state: params.state,
      booking_state: null,
      next_required_step: null,
      assistant_prompt: "",
      flow_complete: true,
      customer_action_required: true,
    };
  }

  const confirmationStepKey = clean(
    confirmationStep.step_key
  );

  const confirmationSlot =
    getStepSlot(confirmationStep);

  const storedConfirmation =
    clean(
      params.state.bookingData?.[
        confirmationStepKey
      ]
    ) ||
    clean(
      confirmationSlot &&
        confirmationSlot !== "none"
        ? params.state.bookingData?.[
            confirmationSlot
          ]
        : ""
    );

  if (storedConfirmation !== "confirm") {
    const confirmationIndex =
      steps.findIndex(
        (step) =>
          clean(step.step_key) ===
          confirmationStepKey
      );

    const bookingState =
      buildBookingState({
        steps,
        state: params.state,
        currentIndex:
          confirmationIndex >= 0
            ? confirmationIndex
            : null,
      });

    const nextResult =
      buildRealtimeNextRequiredStep({
        steps,
        bookingState,
        locale: params.locale,
      });

    return {
      ok: false,
      error:
        "MISSING_FINAL_CONFIRMATION",
      state: params.state,
      booking_state: bookingState,
      next_required_step:
        nextResult.ok
          ? nextResult.next_required_step
          : null,
      assistant_prompt:
        nextResult.ok
          ? clean(
              nextResult.next_required_step
                ?.prompt
            )
          : "",
      flow_complete: false,
      customer_action_required: true,
    };
  }

  const answersBySlot =
    normalizeAnswersToCanonicalSlots({
      steps,
      answersBySlot:
        buildAnswersBySlot({
          args: {},
          callerPhone:
            params.contactPhone,
          state: params.state,
        }),
    });

  const settings =
    await getAppointmentSettings(
      params.tenantId
    );

  if (!settings) {
    return {
      ok: false,
      error:
        "APPOINTMENT_SETTINGS_NOT_FOUND",
      state: params.state,
      booking_state:
        buildBookingState({
          steps,
          state: params.state,
          currentIndex: null,
          confirmed: true,
        }),
      next_required_step: null,
      assistant_prompt: "",
      flow_complete: true,
      customer_action_required: true,
    };
  }

  const stepKeyToSlot =
    buildStepKeyToSlot(steps);

  try {
    const appointment =
      await createAppointment({
        tenantId:
          params.tenantId,
        channel:
          params.channel,
        sessionId:
          params.sessionId,
        answersBySlot,
        stepKeyToSlot,
        settings: {
          default_duration_min:
            Number(
              settings.default_duration_min ||
                0
            ),
          buffer_min:
            Number(
              settings.buffer_min || 0
            ),
          min_lead_minutes:
            Number(
              settings.min_lead_minutes ||
                0
            ),
          timezone:
            clean(settings.timezone) ||
            "America/New_York",
          enabled:
            settings.enabled !== false,
          field_service_area_enabled:
            settings.field_service_area_enabled === true,
        },
      });

    const baseState: CallState = {
      ...params.state,

      bookingData: {
        ...(params.state.bookingData ||
          {}),
        ...answersBySlot,

        appointment_id:
          clean(appointment.id),

        external_calendar_event_id:
          clean(
            appointment.external_calendar_event_id
          ),

        google_event_id:
          clean(
            appointment.google_event_id
          ),

        google_event_link:
          clean(
            appointment.google_event_link
          ),

        booking_outcome:
          "confirmed",
      },
    };

    const transition =
      resolvePostCreateBookingTransition({
        steps,
        confirmationStepKey,
      });

    const informationalState =
      transition.informationalStepIndex ===
      null
        ? null
        : buildBookingState({
            steps,
            state: baseState,
            currentIndex:
              transition.informationalStepIndex,
            confirmed: true,
          });

    const informationalResult =
      informationalState
        ? buildRealtimeNextRequiredStep({
            steps,
            bookingState:
              informationalState,
            locale: params.locale,
          })
        : null;

    const informationalStep =
      informationalResult?.ok
        ? informationalResult.next_required_step
        : null;

    const nextIndex =
      transition.actionableStepIndex;

    const nextState: CallState = {
      ...baseState,

      bookingStepIndex:
        typeof nextIndex === "number"
          ? nextIndex
          : undefined,

      pendingBookingStepKey:
        undefined,

      pendingBookingStepPrompt:
        undefined,

      pendingBookingStepRequired:
        undefined,

      pendingBookingStepSlot:
        undefined,

      pendingBookingStepExpectedType:
        undefined,

      pendingBookingStepValidationConfig:
        undefined,

      bookingTurnStatus:
        nextIndex === null
          ? "flow_complete"
          : "waiting_user_answer",
    };

    const nextBookingState =
      buildBookingState({
        steps,
        state: nextState,
        currentIndex: nextIndex,
        confirmed: true,
      });

    const nextStepResult =
      nextIndex === null
        ? null
        : buildRealtimeNextRequiredStep({
            steps,
            bookingState:
              nextBookingState,
            locale: params.locale,
          });

    const nextRequiredStep =
      nextStepResult?.ok
        ? nextStepResult.next_required_step
        : null;

    if (nextRequiredStep) {
      nextState.pendingBookingStepKey =
        nextRequiredStep.step_key;

      nextState.pendingBookingStepPrompt =
        nextRequiredStep.prompt;

      nextState.pendingBookingStepRequired =
        nextRequiredStep.required;

      nextState.pendingBookingStepSlot =
        nextRequiredStep.slot;

      nextState.pendingBookingStepExpectedType =
        nextRequiredStep.expected_type;

      nextState.pendingBookingStepValidationConfig =
        nextRequiredStep.validation_config;
    }

    const assistantPrompt = [
      clean(
        informationalStep?.prompt
      ),
      clean(
        nextRequiredStep?.prompt
      ),
    ]
      .filter(Boolean)
      .join(" ");

    return {
      ok: true,
      state: nextState,
      appointment,
      booking_state:
        nextBookingState,
      next_required_step:
        nextRequiredStep,
      assistant_prompt:
        assistantPrompt,
      flow_complete:
        nextRequiredStep === null,
      outcome:
        nextRequiredStep
          ? "confirmed_next_action"
          : "confirmed",
    };
  } catch (error) {
    const err = error as Error & {
      code?: string;
      error?: string;
      suggestedStarts?: string[];
      paymentUrl?: string | null;
      policyText?: string | null;
      amountCents?: number | null;
      currency?: string;
      serviceName?: string;
    };

    if (
      err.message ===
        "BOOKING_REQUIRES_DEPOSIT" ||
      err.code ===
        "BOOKING_REQUIRES_DEPOSIT"
    ) {
      const depositState: CallState = {
        ...params.state,

        bookingStepIndex:
          undefined,

        pendingBookingStepKey:
          undefined,

        bookingTurnStatus:
          "flow_complete",

        bookingData: {
          ...(params.state.bookingData ||
            {}),
          ...answersBySlot,

          booking_outcome:
            "requires_deposit",

          deposit_required: "true",

          deposit_service_name:
            clean(err.serviceName),

          deposit_amount_cents:
            typeof err.amountCents ===
              "number"
              ? String(
                  err.amountCents
                )
              : "",

          deposit_currency:
            clean(err.currency) ||
            "USD",

          deposit_payment_url:
            clean(err.paymentUrl),

          deposit_policy_text:
            clean(err.policyText),
        },
      };

      return {
        ok: false,
        error:
          "BOOKING_REQUIRES_DEPOSIT",
        state: depositState,
        booking_state:
          buildBookingState({
            steps,
            state: depositState,
            currentIndex: null,
            confirmed: true,
          }),
        next_required_step: null,
        assistant_prompt:
          clean(err.policyText),
        flow_complete: true,
        customer_action_required: true,
        deposit_payment_url:
          clean(err.paymentUrl) || null,
      };
    }

    if (
      err.error === "SLOT_BUSY" ||
      err.message.startsWith(
        "SLOT_BUSY:"
      )
    ) {
      const recovery =
        buildBookingSlotBusyRecovery({
          flow: steps,
          state: params.state,
          currentLocale:
            params.locale,
          callerPhone:
            params.contactPhone,
          timeZone:
            clean(settings.timezone) ||
            "America/New_York",
          suggestedStarts:
            Array.isArray(
              err.suggestedStarts
            )
              ? err.suggestedStarts
              : [],
        });

      return {
        ok: false,
        error: "SLOT_UNAVAILABLE",
        state: recovery.state,
        booking_state:
          buildBookingState({
            steps,
            state: recovery.state,
            currentIndex:
              recovery.datetimeStepIndex,
          }),
        next_required_step: {
          step_key:
            clean(
              steps[
                recovery
                  .datetimeStepIndex
              ]?.step_key
            ),
          step_order:
            Number(
              steps[
                recovery
                  .datetimeStepIndex
              ]?.step_order || 0
            ),
          slot: "datetime",
          prompt:
            recovery.prompt,
          expected_type:
            clean(
              steps[
                recovery
                  .datetimeStepIndex
              ]?.expected_type
            ) || "datetime",
          required: true,
          retry_prompt:
            recovery.prompt,
          validation_config:
            steps[
              recovery
                .datetimeStepIndex
            ]?.validation_config ||
            null,
          prompt_translations:
            steps[
              recovery
                .datetimeStepIndex
            ]?.prompt_translations ||
            null,
          retry_prompt_translations:
            steps[
              recovery
                .datetimeStepIndex
            ]?.retry_prompt_translations ||
            null,
        },
        assistant_prompt:
          recovery.prompt,
        flow_complete: false,
        customer_action_required: true,
        suggested_times:
          Array.isArray(
            err.suggestedStarts
          )
            ? err.suggestedStarts
            : [],
      };
    }

    return {
      ok: false,
      error:
        clean(err.message) ||
        "BOOKING_FAILED",
      state: params.state,
      booking_state:
        buildBookingState({
          steps,
          state: params.state,
          currentIndex: null,
          confirmed: true,
        }),
      next_required_step: null,
      assistant_prompt: "",
      flow_complete: true,
      customer_action_required: true,
      details: {
        message: err.message,
      },
    };
  }
}