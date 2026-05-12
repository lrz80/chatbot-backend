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

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeServiceKey(value: unknown): string {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function toCleanStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item)).filter(Boolean);
  }

  const single = cleanText(value);
  return single ? [single] : [];
}

function buildVoiceServiceConfigFromStep(step: BookingStep): string {
  const validationConfig =
    step.validation_config && typeof step.validation_config === "object"
      ? (step.validation_config as Record<string, unknown>)
      : null;

  const options = Array.isArray(validationConfig?.options)
    ? validationConfig.options
    : [];

  const lines: string[] = [];

  for (const option of options) {
    if (typeof option === "string") {
      const canonical = cleanText(option);
      if (!canonical) continue;

      lines.push(canonical);
      continue;
    }

    if (!option || typeof option !== "object") {
      continue;
    }

    const record = option as Record<string, unknown>;

    const canonical =
      cleanText(record.value) ||
      cleanText(record.label) ||
      cleanText(record.name) ||
      cleanText(record.title);

    if (!canonical) {
      continue;
    }

    const aliases = Array.from(
      new Set(
        [
          cleanText(record.label),
          cleanText(record.name),
          cleanText(record.title),
          ...toCleanStringArray(record.aliases),
          ...toCleanStringArray(record.synonyms),
          ...toCleanStringArray(record.keywords),
          ...toCleanStringArray(record.examples),
          ...toCleanStringArray(record.speech_hints),
        ].filter(Boolean)
      )
    );

    lines.push(
      aliases.length > 0
        ? `${canonical} | ${aliases.join(", ")}`
        : canonical
    );
  }

  return lines.join("\n").trim();
}

function mergeVoiceServiceConfigs(params: {
  rawConfig: string;
  step: BookingStep;
}): string {
  const merged = new Map<string, { canonical: string; aliases: Set<string> }>();

  const ingestConfig = (raw: string) => {
    const lines = String(raw || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const [canonicalPart, aliasesPart = ""] = line.split("|");
      const canonical = cleanText(canonicalPart);

      if (!canonical) continue;

      const key = normalizeServiceKey(canonical);
      const entry =
        merged.get(key) ||
        { canonical, aliases: new Set<string>() };

      aliasesPart
        .split(",")
        .map((item) => cleanText(item))
        .filter(Boolean)
        .forEach((alias) => entry.aliases.add(alias));

      merged.set(key, entry);
    }
  };

  ingestConfig(params.rawConfig);
  ingestConfig(buildVoiceServiceConfigFromStep(params.step));

  return Array.from(merged.values())
    .map((entry) => {
      const aliases = Array.from(entry.aliases).filter(
        (alias) =>
          normalizeServiceKey(alias) !== normalizeServiceKey(entry.canonical)
      );

      return aliases.length > 0
        ? `${entry.canonical} | ${aliases.join(", ")}`
        : entry.canonical;
    })
    .join("\n")
    .trim();
}

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

  const mergedServiceConfig = mergeVoiceServiceConfigs({
    rawConfig,
    step: currentStep,
  });

  const serviceHints = buildServiceSpeechHints(mergedServiceConfig);

  const serviceResolution = resolveVoiceBookingService({
    userInput: effectiveUserInput,
    rawConfig: mergedServiceConfig,
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