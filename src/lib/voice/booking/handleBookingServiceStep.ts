//src/lib/voice/booking/handleBookingServiceStep.ts
import { twiml } from "twilio";
import {
  resolveBookingFlowSpeech,
  resolveBookingRetryText,
  resolveVoiceBookingService,
} from "../voiceBookingHelpers";
import { twoSentencesMax } from "../speechFormatting";
import { assertNonEmptyBookingSpeech } from "./bookingSpeech";
import type { BookingStep, CreateBookingGatherFn } from "./types";
import type { CallState, VoiceLocale } from "../types";

type HandleBookingServiceStepParams = {
  vr: twiml.VoiceResponse;
  currentStep: BookingStep;
  currentLocale: VoiceLocale;
  voiceName: any;
  callerE164: string | null;
  effectiveUserInput: string;
  state: CallState;
  rawConfig: string;
  createBookingGather: CreateBookingGatherFn;
};

type HandleBookingServiceStepResult =
  | {
      handled: true;
      state: CallState;
      twiml: string;
    }
  | {
      handled: false;
      state: CallState;
      resolvedValue: string;
    };

export async function handleBookingServiceStep(
  params: HandleBookingServiceStepParams
): Promise<HandleBookingServiceStepResult> {
  const {
    vr,
    currentStep,
    currentLocale,
    voiceName,
    callerE164,
    effectiveUserInput,
    state,
    rawConfig,
    createBookingGather,
  } = params;

  const serviceResolution = resolveVoiceBookingService({
    userInput: effectiveUserInput,
    rawConfig,
  });

  if (serviceResolution.kind === "none") {
    const serviceRetryText = resolveBookingRetryText({
      locale: currentLocale,
      retryPrompt: currentStep.retry_prompt || "",
      retryPromptTranslations: currentStep.retry_prompt_translations || null,
      fallbackPrompt: currentStep.prompt || "",
      fallbackPromptTranslations: currentStep.prompt_translations || null,
    });

    const retryPromptResolved = resolveBookingFlowSpeech({
      baseText: serviceRetryText,
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

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
    });

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

  if (serviceResolution.kind === "ambiguous") {
    const optionsText = serviceResolution.options.join(", ");

    const ambiguousBaseText = resolveBookingRetryText({
      locale: currentLocale,
      retryPrompt: currentStep.retry_prompt || "",
      retryPromptTranslations: currentStep.retry_prompt_translations || null,
      fallbackPrompt: currentStep.prompt || "",
      fallbackPromptTranslations: currentStep.prompt_translations || null,
    });

    const ambiguousPrompt = resolveBookingFlowSpeech({
      baseText: ambiguousBaseText,
      locale: currentLocale,
      bookingData: {
        ...(state.bookingData || {}),
        optionsText,
        available_options: optionsText,
      },
      callerE164,
    });

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      twoSentencesMax(ambiguousPrompt)
    );

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  const resolvedValue = serviceResolution.value;

  const localizedServiceDisplay = resolveBookingFlowSpeech({
    baseText: serviceResolution.value,
    locale: currentLocale,
    bookingData: state.bookingData || {},
    callerE164,
  });

  const nextState: CallState = {
    ...state,
    bookingData: {
      ...(state.bookingData || {}),
      service_display: localizedServiceDisplay || serviceResolution.value,
    },
  };

  return {
    handled: false,
    state: nextState,
    resolvedValue,
  };
}