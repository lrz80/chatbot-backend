//src/lib/voice/handleVoiceBookingTurn.ts
import { twiml } from "twilio";
import pool from "../db";
import { getBookingFlow } from "../appointments/getBookingFlow";
import { createAppointmentFromVoice } from "../appointments/createAppointmentFromVoice";
import { resolveVoiceScheduleValidation } from "../appointments/resolveVoiceScheduleValidation";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import { deleteVoiceCallState } from "./deleteVoiceCallState";
import { CallState, VoiceLocale } from "./types";
import {
  buildAnswersBySlot,
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingRetryText,
  resolveBookingSuccessStep,
  resolvePhoneFromVoiceInput,
  resolveVoiceBookingService,
} from "./voiceBookingHelpers";
import { resolveVoiceMetaSignal } from "./resolveVoiceMetaSignal";
import { twoSentencesMax } from "./speechFormatting";
import { handleBookingSlotBusyRecovery } from "./voiceBookingBusyRecovery";
import { handleBookingLocationStep } from "./booking/handleBookingLocationStep";
import { handleBookingDatetimeStep } from "./booking/handleBookingDatetimeStep";
import {
  assertNonEmptyBookingSpeech,
  buildExtraBookingFields,
  createBookingGather,
  resolveBookingSpeechFast,
} from "./booking/bookingSpeech";
import { handleBookingConfirmationStep } from "./booking/handleBookingConfirmationStep";

type CachedBookingFlow = Awaited<ReturnType<typeof getBookingFlow>>;

type BookingFlowCacheEntry = {
  expiresAt: number;
  flow: CachedBookingFlow;
};

type ResolvedVoiceIntent =
  | "booking"
  | "prices"
  | "hours"
  | "location"
  | "human_handoff"
  | "unknown"
  | null;

const BOOKING_FLOW_TTL_MS = 60_000;
const bookingFlowCache = new Map<string, BookingFlowCacheEntry>();

export function clearVoiceBookingFlowCache(tenantId?: string) {
  if (!tenantId) {
    bookingFlowCache.clear();
    return;
  }

  bookingFlowCache.delete(tenantId);
}

async function getCachedBookingFlow(tenantId: string): Promise<CachedBookingFlow> {
  const now = Date.now();
  const cached = bookingFlowCache.get(tenantId);

  if (cached && cached.expiresAt > now) {
    return cached.flow;
  }

  const flow = await getBookingFlow(tenantId);

  bookingFlowCache.set(tenantId, {
    expiresAt: now + BOOKING_FLOW_TTL_MS,
    flow,
  });

  return flow;
}

type HandleVoiceBookingTurnParams = {
  vr: twiml.VoiceResponse;
  tenant: any;
  cfg: any;
  callSid: string;
  didNumber: string;
  callerE164: string | null;
  currentLocale: VoiceLocale;
  voiceName: any;
  state: CallState;
  userInput: string;
  effectiveUserInput: string;
  digits: string;
  resolvedIntent: ResolvedVoiceIntent;
  logBotSay: (input: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

type HandleVoiceBookingTurnResult =
  | { handled: false; state: CallState }
  | { handled: true; state: CallState; twiml: string };

export async function handleVoiceBookingTurn(
  params: HandleVoiceBookingTurnParams
): Promise<HandleVoiceBookingTurnResult> {
  const {
    vr,
    tenant,
    cfg,
    callSid,
    didNumber,
    callerE164,
    currentLocale,
    voiceName,
    logBotSay,
    userInput,
    effectiveUserInput,
    digits,
  } = params;

  let state = params.state;

  if (!effectiveUserInput && typeof state.bookingStepIndex !== "number") {
    return { handled: false, state };
  }

  const bookingAlreadyActive = typeof state.bookingStepIndex === "number";

  if (!bookingAlreadyActive && !effectiveUserInput) {
    return { handled: false, state };
  }

  const resolvedIntent = bookingAlreadyActive
    ? "booking"
    : params.resolvedIntent;

  const wantsBooking =
    bookingAlreadyActive ||
    resolvedIntent === "booking";

  if (!wantsBooking) {
    return { handled: false, state };
  }

  const flow = await getCachedBookingFlow(tenant.id);

  if (!flow.length) {
    throw new Error("BOOKING_FLOW_NOT_CONFIGURED");
  }

  if (typeof state.bookingStepIndex !== "number") {
    const firstStep = flow[0];

    const preservedBookingData: Record<string, any> = {};

    if (state.bookingData?.__voice_intro_played) {
      preservedBookingData.__voice_intro_played =
        state.bookingData.__voice_intro_played;
    }

    state = {
      ...state,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      smsSent: false,
      bookingStepIndex: 0,
      bookingData: preservedBookingData,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: state.altDest ?? null,
      smsSent: false,
      bookingStepIndex: 0,
      bookingData: preservedBookingData,
    });

    const firstStepPromptText = resolveBookingPromptText({
      locale: currentLocale,
      prompt: firstStep.prompt || "",
      promptTranslations: firstStep.prompt_translations || null,
    });

    const askResolved =
      resolveBookingSpeechFast({
        baseText: firstStepPromptText,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      }) ||
      (resolveBookingFlowSpeech({
        baseText: firstStepPromptText,
        locale: currentLocale,
        bookingData: state.bookingData || {},
        callerE164,
      }));

    const ask = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: askResolved,
        stepKey: firstStep.step_key,
        field: "prompt",
      })
    );

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
    });

    gather.say({ language: currentLocale as any, voice: voiceName }, ask);

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: ask,
      lang: currentLocale,
      context: "booking_start",
    });

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  const currentIndex = state.bookingStepIndex;
  const currentStep = flow[currentIndex];

  if (!currentStep) {
    await deleteVoiceCallState(callSid);
    throw new Error("BOOKING_STEP_NOT_FOUND");
  }

  if (!effectiveUserInput && !digits) {
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

    const prompt = twoSentencesMax(
      assertNonEmptyBookingSpeech({
        text: retryPromptResolved,
        stepKey: currentStep.step_key,
        field: currentStep.retry_prompt ? "retry_prompt" : "prompt",
      })
    );

    const gather = createBookingGather({
      vr,
      locale: currentLocale,
      isPhoneStep: currentStep.expected_type === "phone",
      isConfirmationStep: currentStep.expected_type === "confirmation",
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName },
      prompt
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: prompt,
      lang: currentLocale,
      context: `booking_empty_input_retry:${currentStep.step_key}`,
    });

    return {
      handled: true,
      state,
      twiml: vr.toString(),
    };
  }

  if (currentStep.expected_type === "confirmation") {
    return handleBookingConfirmationStep({
      vr,
      tenant,
      cfg,
      flow,
      currentStep,
      currentLocale,
      voiceName,
      callSid,
      didNumber,
      callerE164,
      userInput,
      digits,
      state,
      createBookingGather,
      logBotSay,
      upsertVoiceCallState,
    });
  }

  if (currentStep.expected_type === "phone") {
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

    const nextStepPromptTextAfterPhone = resolveBookingPromptText({
      locale: currentLocale,
      prompt: nextStep.prompt || "",
      promptTranslations: nextStep.prompt_translations || null,
    });

    const prompt = twoSentencesMax(
      resolveBookingFlowSpeech({
        baseText: nextStepPromptTextAfterPhone,
        locale: currentLocale,
        bookingData: nextData,
        callerE164,
      })
    );

    state = {
      ...state,
      bookingStepIndex: nextIndex,
      bookingData: nextData,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: state.awaiting ?? false,
      pendingType: state.pendingType ?? null,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
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
      state,
      twiml: vr.toString(),
    };
  }

  let resolvedStepValue = effectiveUserInput;

  const rawSlot =
    typeof currentStep.validation_config?.slot === "string"
      ? currentStep.validation_config.slot.trim()
      : "";

  const isServiceStep =
    currentStep.step_key === "service" || rawSlot === "service";

  const isLocationDetailStep =
    currentStep.step_key === "location_detail" || rawSlot === "location_detail";

  if (isServiceStep) {
    const serviceResolution = resolveVoiceBookingService({
      userInput: effectiveUserInput,
      rawConfig: cfg?.booking_services_text || "",
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

    resolvedStepValue = serviceResolution.value;

    const localizedServiceDisplay = resolveBookingFlowSpeech({
      baseText: serviceResolution.value,
      locale: currentLocale,
      bookingData: state.bookingData || {},
      callerE164,
    });

    state = {
      ...state,
      bookingData: {
        ...(state.bookingData || {}),
        service_display: localizedServiceDisplay || serviceResolution.value,
      },
    };
  }

  if (isLocationDetailStep) {
    const locationStepResult = await handleBookingLocationStep({
      vr,
      currentStep,
      effectiveUserInput,
      currentLocale,
      voiceName,
      callerE164,
      state,
      createBookingGather,
    });

    if (locationStepResult.handled) {
      return {
        handled: true,
        state: locationStepResult.state,
        twiml: locationStepResult.twiml,
      };
    }

    resolvedStepValue = locationStepResult.resolvedValue;
  }

  const isDatetimeStep =
    currentStep.step_key === "datetime" || rawSlot === "datetime";

  if (isDatetimeStep) {
    const datetimeStepResult = await handleBookingDatetimeStep({
      vr,
      tenantId: tenant.id,
      callSid,
      didNumber,
      currentStep,
      currentIndex,
      currentLocale,
      voiceName,
      callerE164,
      state,
      resolvedStepValue,
      createBookingGather,
      logBotSay,
    });

    if (datetimeStepResult.handled) {
      return {
        handled: true,
        state: datetimeStepResult.state,
        twiml: datetimeStepResult.twiml,
      };
    }

    state = datetimeStepResult.nextState;
    resolvedStepValue = datetimeStepResult.resolvedValue;
  }

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

  state = {
    ...state,
    bookingStepIndex: nextIndex,
    bookingData: nextData,
  };

  await upsertVoiceCallState({
    callSid,
    tenantId: tenant.id,
    lang: state.lang ?? currentLocale,
    turn: state.turn ?? 0,
    awaiting: state.awaiting ?? false,
    pendingType: state.pendingType ?? null,
    awaitingNumber: state.awaitingNumber ?? false,
    altDest: state.altDest ?? null,
    smsSent: state.smsSent ?? false,
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
    state,
    twiml: vr.toString(),
  };
}