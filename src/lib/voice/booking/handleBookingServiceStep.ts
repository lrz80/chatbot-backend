// src/lib/voice/booking/handleBookingServiceStep.ts
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

export type CanonicalBookingServiceStepParams = {
  currentStep: BookingStep;
  currentLocale: VoiceLocale;
  callerE164: string | null;
  effectiveUserInput: string;
  state: CallState;
  rawConfig: string;
};

export type CanonicalBookingServiceStepResult =
  | {
      kind: "retry";
      state: CallState;
      prompt: string;
      hints?: string;
    }
  | {
      kind: "ambiguous";
      state: CallState;
      prompt: string;
      hints?: string;
      options: string[];
    }
  | {
      kind: "resolved";
      state: CallState;
      resolvedValue: string;
    };

function buildServiceSpeechHints(rawConfig: string): string | undefined {
  const text = String(rawConfig || "").trim();
  if (!text) return undefined;

  const tokens = text
    .split(/\r?\n/)
    .flatMap((line) => {
      const cleanLine = line.trim();
      if (!cleanLine) return [];

      const [canonicalRaw, aliasesRaw = ""] = cleanLine.split("|");
      const canonical = String(canonicalRaw || "").trim();
      const aliases = String(aliasesRaw || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      return [canonical, ...aliases].filter(Boolean);
    });

  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const token of tokens) {
    const normalized = token.toLowerCase().trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(token);
  }

  return deduped.length ? deduped.join(", ") : undefined;
}

export async function executeCanonicalBookingServiceStep(
  params: CanonicalBookingServiceStepParams
): Promise<CanonicalBookingServiceStepResult> {
  const {
    currentStep,
    currentLocale,
    callerE164,
    effectiveUserInput,
    state,
    rawConfig,
  } = params;

  const serviceHints = buildServiceSpeechHints(rawConfig);

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

    return {
      kind: "retry",
      state,
      prompt: retryPrompt,
      hints: serviceHints,
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

    const ambiguousPrompt = twoSentencesMax(
      resolveBookingFlowSpeech({
        baseText: ambiguousBaseText,
        locale: currentLocale,
        bookingData: {
          ...(state.bookingData || {}),
          optionsText,
          available_options: optionsText,
        },
        callerE164,
      })
    );

    return {
      kind: "ambiguous",
      state,
      prompt: ambiguousPrompt,
      hints: serviceHints,
      options: serviceResolution.options,
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
    kind: "resolved",
    state: nextState,
    resolvedValue,
  };
}

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

  const canonical = await executeCanonicalBookingServiceStep({
    currentStep,
    currentLocale,
    callerE164,
    effectiveUserInput,
    state,
    rawConfig,
  });

  if (canonical.kind === "retry" || canonical.kind === "ambiguous") {
    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      step: currentStep,
      hints: canonical.hints,
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      canonical.prompt
    );

    return {
      handled: true,
      state: canonical.state,
      twiml: vr.toString(),
    };
  }

  return {
    handled: false,
    state: canonical.state,
    resolvedValue: canonical.resolvedValue,
  };
}