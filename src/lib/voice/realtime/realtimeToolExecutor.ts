import { getBookingFlow } from "../../appointments/getBookingFlow";
import {
  resolveBookingPromptText,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import type { CallState, VoiceLocale } from "../types";
import {
  clean,
  extractStringRecord,
  getStepSlot,
  isConfirmationLikeStep,
  sortFlowSteps,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  resolveCurrentStepIndex,
  buildCanonicalCallState,
  renderBookingStepTemplate,
  buildBookingPromptTemplateValues,
  type BookingFlowStepLike,
  type BookingState,
} from "./realtimeBookingFlowUtils";
import { handleRealtimeSubmitBookingStep } from "./handlers/handleRealtimeSubmitBookingStep";
import { handleRealtimeCreateAppointment } from "./handlers/handleRealtimeCreateAppointment";
import { twiml } from "twilio";
import { parseBookingSmsPayload } from "../runtime/voiceBookingSmsHelpers";
import { sendBookingConfirmationSms } from "../runtime/sendBookingConfirmationSms";

type ExecuteRealtimeToolParams = {
  tenantId: string;
  callerPhone: string | null;
  toolName: string;
  args: Record<string, any>;

  tenant?: any;
  cfg?: any;
  callSid?: string;
  didNumber?: string;
  currentLocale?: VoiceLocale;
  state?: CallState;
  userInput?: string;
  digits?: string;
};

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

function getRealtimeBookingContext(
  params: ExecuteRealtimeToolParams
): RealtimeBookingContext | null {
  const {
    tenant,
    cfg,
    callSid,
    didNumber,
    currentLocale,
    state,
    userInput,
    digits,
  } = params;

  if (!tenant || !callSid || !didNumber || !currentLocale || !state) {
    return null;
  }

  return {
    tenant,
    cfg: cfg ?? {},
    callSid,
    didNumber,
    currentLocale,
    state,
    userInput: clean(userInput),
    digits: clean(digits),
  };
}

function mapStepForRealtime(
  step: BookingFlowStepLike,
  locale?: VoiceLocale
): RealtimeMappedStep {
  const resolvedPrompt = locale
    ? resolveBookingPromptText({
        locale,
        prompt: step.prompt || "",
        promptTranslations:
          (step.prompt_translations as Record<string, string> | null) || null,
      })
    : step.prompt || "";

  const resolvedRetryPrompt = locale
    ? resolveBookingRetryText({
        locale,
        retryPrompt: step.retry_prompt || "",
        retryPromptTranslations:
          (step.retry_prompt_translations as Record<string, string> | null) ||
          null,
        fallbackPrompt: step.prompt || "",
        fallbackPromptTranslations:
          (step.prompt_translations as Record<string, string> | null) || null,
      })
    : step.retry_prompt || "";

  return {
    step_key: clean(step.step_key),
    step_order: Number(step.step_order || 0),
    slot: getStepSlot(step),
    prompt: resolvedPrompt,
    expected_type: step.expected_type || "text",
    required: step.required === true,
    retry_prompt: resolvedRetryPrompt,
    validation_config: step.validation_config || null,
    prompt_translations: step.prompt_translations || null,
    retry_prompt_translations: step.retry_prompt_translations || null,
  };
}

function buildRealtimeBookingState(params: {
  steps: BookingFlowStepLike[];
  state: CallState;
  explicitCurrentIndex?: number | null;
  finalConfirmationGranted?: boolean;
  readyToCreate?: boolean;
}): BookingState {
  const {
    steps,
    state,
    explicitCurrentIndex,
    finalConfirmationGranted = false,
    readyToCreate = false,
  } = params;

  const answersBySlot = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: extractStringRecord(state.bookingData),
  });

  const currentIndex =
    typeof explicitCurrentIndex === "number"
      ? explicitCurrentIndex
      : resolveCurrentStepIndex({
          steps,
          state,
          answersBySlot,
        });

  const currentStep =
    typeof currentIndex === "number" ? steps[currentIndex] : null;

  return {
    current_step_key: currentStep ? clean(currentStep.step_key) || null : null,
    current_step_slot: currentStep ? getStepSlot(currentStep) || null : null,
    awaiting_confirmation: currentStep ? isConfirmationLikeStep(currentStep) : false,
    final_confirmation_granted: finalConfirmationGranted,
    ready_to_create: readyToCreate,
    collected_slots: answersBySlot,
  };
}

function buildNextRequiredStep(params: {
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
  locale?: VoiceLocale;
  overridePrompt?: string;
}): RealtimeMappedStep | null {
  const { steps, bookingState, locale, overridePrompt } = params;

  if (!bookingState.current_step_key) {
    return null;
  }

  const step = steps.find(
    (candidate) =>
      clean(candidate.step_key) === clean(bookingState.current_step_key)
  );

  if (!step) {
    return null;
  }

  const mapped = mapStepForRealtime(step, locale);
  const templateValues = buildBookingPromptTemplateValues(bookingState);

  const renderedPrompt = overridePrompt
    ? overridePrompt
    : renderBookingStepTemplate(mapped.prompt, templateValues);

  const renderedRetryPrompt = renderBookingStepTemplate(
    mapped.retry_prompt,
    templateValues
  );

  return {
    step_key: mapped.step_key,
    step_order: mapped.step_order,
    slot: mapped.slot,
    prompt: renderedPrompt,
    expected_type: mapped.expected_type,
    required: mapped.required,
    retry_prompt: renderedRetryPrompt,
    validation_config: null,
    prompt_translations: null,
    retry_prompt_translations: null,
  };
}

async function persistVoiceState(params: {
  tenantId: string;
  callSid: string;
  state: CallState;
  locale: VoiceLocale;
}): Promise<void> {
  const { tenantId, callSid, state, locale } = params;

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: state.lang ?? locale,
    turn: state.turn ?? 0,
    awaiting: state.awaiting ?? false,
    pendingType: state.pendingType ?? null,
    awaitingNumber: state.awaitingNumber ?? false,
    altDest: state.altDest ?? null,
    smsSent: state.smsSent ?? false,
    bookingStepIndex:
      typeof state.bookingStepIndex === "number" ? state.bookingStepIndex : null,
    bookingData: state.bookingData || {},
  });
}

function buildContextMissingResult() {
  return {
    ok: false,
    error: "REALTIME_BOOKING_CONTEXT_MISSING",
    message:
      "Realtime booking context is missing. The realtime bridge must pass tenant, callSid, didNumber, currentLocale, state, userInput, and digits.",
  };
}

export async function executeRealtimeTool(
  params: ExecuteRealtimeToolParams
): Promise<any> {
  const { tenantId, callerPhone, toolName, args } = params;

  const bookingContext =
    toolName === "get_booking_flow" ||
    toolName === "submit_booking_step" ||
    toolName === "create_appointment" ||
    toolName === "send_booking_sms"
      ? getRealtimeBookingContext(params)
      : null;

  switch (toolName) {
    case "get_booking_flow": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      const answersBySlot = normalizeAnswersToCanonicalSlots({
        steps,
        answersBySlot: buildAnswersBySlot({
          args,
          callerPhone,
          state: bookingContext.state,
        }),
      });

      const initialState = buildCanonicalCallState({
        state: bookingContext.state,
        answersBySlot,
        bookingStepIndex: resolveCurrentStepIndex({
          steps,
          state: bookingContext.state,
          answersBySlot,
        }),
      });

      const bookingState = buildRealtimeBookingState({
        steps,
        state: initialState,
      });

      return {
        ok: true,
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
        }),
      };
    }

    case "submit_booking_step": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      return handleRealtimeSubmitBookingStep({
        tenantId,
        callerPhone,
        args,
        bookingContext,
        steps,
        buildRealtimeBookingState,
        buildNextRequiredStep,
        persistVoiceState,
      });
    }

    case "create_appointment": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      return handleRealtimeCreateAppointment({
        tenantId,
        callerPhone,
        args,
        bookingContext,
        steps,
        buildRealtimeBookingState,
        buildNextRequiredStep,
      });
    }

    case "send_booking_sms": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const bookingSmsPayload = parseBookingSmsPayload(
        bookingContext.state.bookingData || {}
      );

      if (!bookingSmsPayload) {
        return {
          ok: false,
          error: "BOOKING_SMS_PAYLOAD_MISSING",
          message:
            "The booking SMS payload is missing. The appointment may not have been confirmed yet.",
        };
      }

      const vr = new twiml.VoiceResponse();

      const smsResult = await sendBookingConfirmationSms({
        tenant: bookingContext.tenant,
        callSid: bookingContext.callSid,
        currentLocale: bookingContext.currentLocale,
        voiceName: null as any,
        state: bookingContext.state,
        bookingSmsPayload,
        callerE164: callerPhone,
        didNumber: bookingContext.didNumber,
        vr,
        logBotSay: ({ callSid, to, text, lang, context }) => {
          console.log("[VOICE_REALTIME][SAY]", {
            callSid,
            to,
            text,
            lang,
            context,
          });
        },
        successMode: "append_to_reply",
      });

      Object.assign(bookingContext.state, smsResult.updatedState);

      await persistVoiceState({
        tenantId,
        callSid: bookingContext.callSid,
        state: smsResult.updatedState,
        locale: bookingContext.currentLocale,
      });

      return {
        ok: smsResult.sent === true,
        sent: smsResult.sent,
        message:
          smsResult.appendedText ||
          "The booking SMS flow completed.",
        assistant_prompt:
          smsResult.appendedText ||
          "Tell the caller whether the booking SMS was sent, then ask if they need anything else.",
        booking_state: buildRealtimeBookingState({
          steps: sortFlowSteps(
            (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
          ),
          state: smsResult.updatedState,
          explicitCurrentIndex: null,
          finalConfirmationGranted: true,
          readyToCreate: false,
        }),
        next_required_step: null,
      };
    }

    case "end_call": {
      return {
        ok: true,
        hangup: true,
      };
    }

    default:
      return {
        ok: false,
        error: "UNKNOWN_TOOL",
        message: `Unknown realtime tool: ${toolName}`,
      };
  }
}