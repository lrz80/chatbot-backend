//src/lib/voice/booking/handleBookingPhoneStep.ts
import { twiml } from "twilio";
import {
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingRetryText,
  resolvePhoneFromVoiceInput,
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

type HandleBookingPhoneStepParams = {
  vr: twiml.VoiceResponse;
  tenantId: string;
  flow: BookingFlow;
  currentStep: BookingStep;
  currentIndex: number;
  currentLocale: VoiceLocale;
  voiceName: any;
  callSid: string;
  callerE164: string | null;
  effectiveUserInput: string;
  digits: string;
  state: CallState;
  createBookingGather: CreateBookingGatherFn;
  upsertVoiceCallState: typeof import("../upsertVoiceCallState").upsertVoiceCallState;
};

export async function handleBookingPhoneStep(
  params: HandleBookingPhoneStepParams
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
    effectiveUserInput,
    digits,
    state,
    createBookingGather,
    upsertVoiceCallState,
  } = params;

  const phoneResolution = resolvePhoneFromVoiceInput({
    userInput: effectiveUserInput,
    digits,
    callerE164,
    step: currentStep,
  });

  if (!phoneResolution.ok) {
    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isPhoneStep: true,
    });

    const phoneRetryText = resolveBookingRetryText({
      locale: currentLocale,
      retryPrompt: currentStep.retry_prompt || "",
      retryPromptTranslations: currentStep.retry_prompt_translations || null,
      fallbackPrompt: currentStep.prompt || "",
      fallbackPromptTranslations: currentStep.prompt_translations || null,
    });

    const retryPromptResolved = resolveBookingFlowSpeech({
      baseText: phoneRetryText,
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    });

    const retryPrompt = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: retryPromptResolved,
        stepKey: currentStep.step_key,
        field: currentStep.retry_prompt ? "retry_prompt" : "prompt",
      })
    );

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      retryPrompt
    );

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  const nextData: Record<string, string> = {
    ...(state.bookingData || {}),
    [currentStep.step_key]: phoneResolution.value,
  };

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

  const prompt = twoSentencesMax(
    resolveBookingFlowSpeech({
      baseText: nextStepPromptText,
      locale: currentLocale,
      bookingData: nextData,
      callerE164,
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