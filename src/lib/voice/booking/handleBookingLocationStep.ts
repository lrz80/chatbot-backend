//src/lib/voice/booking/handleBookingLocationStep.ts
import { twiml } from "twilio";
import type { CallState, VoiceLocale } from "../types";
import {
  resolveBookingFlowSpeech,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { twoSentencesMax } from "../speechFormatting";

type BookingStepLike = {
  step_key: string;
  prompt?: string | null;
  prompt_translations?: Record<string, string> | null;
  retry_prompt?: string | null;
  retry_prompt_translations?: Record<string, string> | null;
};

type HandleBookingLocationStepParams = {
  vr: twiml.VoiceResponse;
  currentStep: BookingStepLike;
  effectiveUserInput: string;
  currentLocale: VoiceLocale;
  voiceName: any;
  callerE164: string | null;
  state: CallState;
  createBookingGather: (params: {
    vr: twiml.VoiceResponse;
    locale: VoiceLocale;
    isPhoneStep?: boolean;
    isConfirmationStep?: boolean;
  }) => ReturnType<twiml.VoiceResponse["gather"]>;
};

type HandleBookingLocationStepResult =
  | {
      handled: false;
      resolvedValue: string;
    }
  | {
      handled: true;
      twiml: string;
      state: CallState;
    };

function assertNonEmptyBookingSpeech(input: {
  text: string;
  stepKey: string;
  field: "prompt" | "retry_prompt";
}) {
  const value = String(input.text || "").trim();

  if (!value) {
    throw new Error(
      `BOOKING_FLOW_EMPTY_SPEECH:${input.stepKey}:${input.field}`
    );
  }

  return value;
}

function normalizeLocationInput(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function resolveLocationValue(input: string): string | null {
  const normalized = normalizeLocationInput(input);

  if (
    normalized.includes("salon") ||
    normalized.includes("en el salon") ||
    normalized.includes("in salon")
  ) {
    return "salón";
  }

  if (
    normalized.includes("mobile") ||
    normalized.includes("movil") ||
    normalized.includes("a domicilio") ||
    normalized.includes("en mi ubicacion") ||
    normalized.includes("en tu ubicacion")
  ) {
    return "mobile grooming";
  }

  return null;
}

export async function handleBookingLocationStep(
  params: HandleBookingLocationStepParams
): Promise<HandleBookingLocationStepResult> {
  const {
    vr,
    currentStep,
    effectiveUserInput,
    currentLocale,
    voiceName,
    callerE164,
    state,
    createBookingGather,
  } = params;

  const matchedLocation = resolveLocationValue(effectiveUserInput);

  if (matchedLocation) {
    return {
      handled: false,
      resolvedValue: matchedLocation,
    };
  }

  const retryText = resolveBookingRetryText({
    locale: currentLocale,
    retryPrompt: currentStep.retry_prompt || "",
    retryPromptTranslations: currentStep.retry_prompt_translations || null,
    fallbackPrompt: currentStep.prompt || "",
    fallbackPromptTranslations: currentStep.prompt_translations || null,
  });

  const retryPromptResolved = resolveBookingFlowSpeech({
    baseText: retryText,
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