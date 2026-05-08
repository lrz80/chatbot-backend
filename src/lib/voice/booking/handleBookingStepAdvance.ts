//src/lib/voice/booking/handleBookingStepAdvance.ts
import { twiml } from "twilio";
import {
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
} from "../voiceBookingHelpers";
import { twoSentencesMax } from "../speechFormatting";
import { deleteVoiceCallState } from "../deleteVoiceCallState";
import { assertNonEmptyBookingSpeech } from "./bookingSpeech";
import type {
  BookingFlow,
  BookingStep,
  BookingStepHandlerResult,
  CreateBookingGatherFn,
} from "./types";
import type { CallState, VoiceLocale } from "../types";

type HandleBookingStepAdvanceParams = {
  vr: twiml.VoiceResponse;
  tenantId: string;
  flow: BookingFlow;
  currentStep: BookingStep;
  currentIndex: number;
  currentLocale: VoiceLocale;
  voiceName: any;
  callSid: string;
  callerE164: string | null;
  state: CallState;
  resolvedStepValue: string;
  isServiceStep?: boolean;
  isDatetimeStep?: boolean;
  createBookingGather: CreateBookingGatherFn;
  upsertVoiceCallState: typeof import("../upsertVoiceCallState").upsertVoiceCallState;
};

export async function handleBookingStepAdvance(
  params: HandleBookingStepAdvanceParams
): Promise<BookingStepHandlerResult> {
  const {
    vr,
    tenantId,
    flow,
    currentStep,
    currentIndex,
    currentLocale,
    voiceName,
    callSid,
    callerE164,
    state,
    resolvedStepValue,
    isServiceStep = false,
    isDatetimeStep = false,
    createBookingGather,
    upsertVoiceCallState,
  } = params;

  const nextData: Record<string, string> = {
    ...(state.bookingData || {}),
    [currentStep.step_key]: String(resolvedStepValue || "").trim(),
    ...(isServiceStep
      ? {
          service_display: String(
            state.bookingData?.service_display || resolvedStepValue || ""
          ).trim(),
        }
      : {}),
    ...(isDatetimeStep
      ? {
          datetime_display: String(resolvedStepValue || "").trim(),
        }
      : {}),
  };

  if (isDatetimeStep) {
    delete nextData.__datetime_reference_suggested_starts;
  }

  const nextIndex = currentIndex + 1;
  const nextStep = flow[nextIndex];

  if (!nextStep) {
    await deleteVoiceCallState(callSid);
    throw new Error("BOOKING_CONFIRM_STEP_MISSING");
  }

  const nextStepPromptText = resolveBookingPromptText({
    locale: currentLocale,
    prompt: nextStep.prompt || "",
    promptTranslations: nextStep.prompt_translations || null,
  });

  const promptResolved = resolveBookingFlowSpeech({
    baseText: nextStepPromptText,
    locale: currentLocale,
    bookingData: nextData,
    callerE164,
  });

  const prompt = twoSentencesMax(
    assertNonEmptyBookingSpeech({
      text: promptResolved,
      stepKey: nextStep.step_key,
      field: "prompt",
    })
  );

  const nextState: CallState = {
    ...state,
    bookingStepIndex: nextIndex,
    bookingData: nextData,
  };

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: nextState.lang ?? currentLocale,
    turn: nextState.turn ?? 0,
    awaiting: nextState.awaiting ?? false,
    pendingType: nextState.pendingType ?? null,
    awaitingNumber: nextState.awaitingNumber ?? false,
    altDest: nextState.altDest ?? null,
    smsSent: nextState.smsSent ?? false,
    bookingStepIndex: nextIndex,
    bookingData: nextData,
  });

  const isPhoneStep = nextStep.expected_type === "phone";
  const isConfirmationStep = nextStep.expected_type === "confirmation";

  const gather = createBookingGather({
    vr,
    locale: currentLocale,
    isPhoneStep,
    isConfirmationStep,
  });

  gather.say(
    { language: currentLocale as any, voice: voiceName },
    prompt
  );

  return {
    handled: true,
    state: nextState,
    twiml: vr.toString(),
  };
}