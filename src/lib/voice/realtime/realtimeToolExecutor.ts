//src/lib/voice/realtime/realtimeToolExecutor.ts
import {
  getSharedBookingFlow,
} from "../../appointments/getBookingFlow";
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
  type BookingFlowStepLike,
  type BookingState,
} from "./realtimeBookingFlowUtils";
import { handleRealtimeSubmitBookingStep } from "./handlers/handleRealtimeSubmitBookingStep";
import { handleRealtimeCreateAppointment } from "./handlers/handleRealtimeCreateAppointment";
import { twiml } from "twilio";
import { parseBookingSmsPayload } from "../runtime/voiceBookingSmsHelpers";
import { sendBookingConfirmationSms } from "../runtime/sendBookingConfirmationSms";
import { sendUsefulLinkSms } from "../runtime/sendUsefulLinkSms";
import {
  buildRealtimeNextRequiredStep,
  type RealtimeMappedStep,
} from "./bookingStep/buildRealtimeNextRequiredStep";

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
  twilioAccountSid?: string | null;
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

function buildNextRequiredStepOrThrow(params: {
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
  locale?: VoiceLocale;
  overridePrompt?: string;
}): RealtimeMappedStep | null {
  const nextStepResult = buildRealtimeNextRequiredStep(params);

  if (!nextStepResult.ok) {
    throw new Error(
      [
        "BOOKING_STEP_TEMPLATE_INVALID",
        `step_key=${nextStepResult.step_key}`,
        `slot=${nextStepResult.slot}`,
        `prompt_error=${nextStepResult.prompt_error}`,
        `retry_prompt_error=${nextStepResult.retry_prompt_error}`,
      ].join(";")
    );
  }

  return nextStepResult.next_required_step;
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
  const {
    tenantId,
    callerPhone,
    toolName,
    args,
    twilioAccountSid,
  } = params;

  const bookingContext =
    toolName === "get_booking_flow" ||
    toolName === "submit_booking_step" ||
    toolName === "create_appointment" ||
    toolName === "send_booking_sms" ||
    toolName === "send_useful_link_sms"
      ? getRealtimeBookingContext(params)
      : null;

  switch (toolName) {
    case "get_booking_flow": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getSharedBookingFlow(tenantId)) as BookingFlowStepLike[]
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

      const nextStepResult = buildRealtimeNextRequiredStep({
        steps,
        bookingState,
        locale: bookingContext.currentLocale,
      });

      if (!nextStepResult.ok) {
        return {
          ok: false,
          error: nextStepResult.error,
          step_key: nextStepResult.step_key,
          slot: nextStepResult.slot,
          prompt_error: nextStepResult.prompt_error,
          retry_prompt_error: nextStepResult.retry_prompt_error,
          message:
            "BOOKING_FLOW_CONFIGURATION_INVALID",
          booking_state: bookingState,
          next_required_step: null,
        };
      }

      return {
        ok: true,
        booking_state: bookingState,
        next_required_step: nextStepResult.next_required_step,
      };
    }

    case "submit_booking_step": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getSharedBookingFlow(tenantId)) as BookingFlowStepLike[]
      );

      return handleRealtimeSubmitBookingStep({
        tenantId,
        callerPhone,
        args,
        bookingContext,
        steps,
        buildRealtimeBookingState,
        persistVoiceState,
      });
    }

    case "create_appointment": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getSharedBookingFlow(tenantId)) as BookingFlowStepLike[]
      );

      return handleRealtimeCreateAppointment({
        tenantId,
        callerPhone,
        args,
        bookingContext,
        steps,
        buildRealtimeBookingState,
        buildNextRequiredStep: buildNextRequiredStepOrThrow,
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
            (await getSharedBookingFlow(tenantId)) as BookingFlowStepLike[]
          ),
          state: smsResult.updatedState,
          explicitCurrentIndex: null,
          finalConfirmationGranted: true,
          readyToCreate: false,
        }),
        next_required_step: null,
      };
    }

    case "send_useful_link_sms": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const rawLinkTypes = Array.isArray(args?.link_types)
        ? args.link_types
        : [];

      const linkTypes = rawLinkTypes
        .map((item: unknown) => clean(item))
        .filter(Boolean);

      const smsResult = await sendUsefulLinkSms({
        tenant: bookingContext.tenant,
        callSid: bookingContext.callSid,
        currentLocale: bookingContext.currentLocale,
        state: bookingContext.state,
        callerE164: callerPhone,
        linkTypes,
      });

      Object.assign(bookingContext.state, smsResult.updatedState);

      const updatedState: CallState = {
        ...smsResult.updatedState,
        awaitingPostBookingClosure: true,
        bookingData: {
          ...(smsResult.updatedState.bookingData || {}),
          useful_link_sms_sent: "true",
          useful_link_sms_followup_pending: "true",
        },
      };

      Object.assign(bookingContext.state, updatedState);

      await persistVoiceState({
        tenantId,
        callSid: bookingContext.callSid,
        state: updatedState,
        locale: bookingContext.currentLocale,
      });

      return {
        ok: smsResult.sent === true,
        sent: smsResult.sent,
        error: smsResult.error,
        link_type: smsResult.link?.tipo || null,
        link_name: smsResult.link?.nombre || null,
        booking_state: buildRealtimeBookingState({
          steps: sortFlowSteps(
            (await getSharedBookingFlow(tenantId)) as BookingFlowStepLike[]
          ),
          state: updatedState,
          explicitCurrentIndex: null,
          finalConfirmationGranted: true,
          readyToCreate: false,
        }),
        next_required_step: null,
      };
    }

    case "transfer_to_human": {
      const cfgRepresentativeNumber = clean(
        params.cfg?.representante_number
      );

      const tenantRepresentativeNumber = clean(
        params.tenant?.representante_number
      );

      const representativeNumber =
        cfgRepresentativeNumber ||
        tenantRepresentativeNumber ||
        null;

      console.log("[VOICE_REALTIME][TRANSFER_CONTEXT]", {
        callSid: params.callSid || null,
        twilioAccountSid: twilioAccountSid || null,
        cfgRepresentativeNumber:
          cfgRepresentativeNumber || null,
        tenantRepresentativeNumber:
          tenantRepresentativeNumber || null,
        hasCfg: Boolean(params.cfg),
        hasTenant: Boolean(params.tenant),
      });

      if (!params.callSid) {
        return {
          ok: false,
          transferred: false,
          error: "CALL_SID_MISSING",
          message: "The active call could not be identified.",
        };
      }

      if (!representativeNumber) {
        return {
          ok: false,
          transferred: false,
          error: "REPRESENTATIVE_NOT_CONFIGURED",
          message:
            "Direct transfer is not configured for this business.",
        };
      }

      if (!/^\+\d{10,15}$/.test(representativeNumber)) {
        return {
          ok: false,
          transferred: false,
          error: "REPRESENTATIVE_NUMBER_INVALID",
          message:
            "The configured representative number is invalid.",
        };
      }

      return {
        ok: true,
        transferred: false,
        transfer_pending: true,
        representative_number: representativeNumber,
        announcement_required: true,
      };
    }

    case "end_call": {
      const hasPendingUsefulLinkFollowup =
        params.state?.awaitingPostBookingClosure === true &&
        clean(params.state?.bookingData?.useful_link_sms_followup_pending) === "true";

      if (hasPendingUsefulLinkFollowup) {
        return {
          ok: false,
          hangup: false,
          error: "POST_SMS_FOLLOWUP_PENDING",
          message:
            "The caller has not answered the final follow-up question after the useful link SMS.",
        };
      }

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