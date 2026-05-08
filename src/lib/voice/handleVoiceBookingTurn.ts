//src/lib/voice/handleVoiceBookingTurn.ts
import { twiml } from "twilio";
import { upsertVoiceCallState } from "./upsertVoiceCallState";
import { deleteVoiceCallState } from "./deleteVoiceCallState";
import { CallState, VoiceLocale } from "./types";
import {
  resolveBookingFlowSpeech,
  resolveBookingPromptText,
  resolveBookingRetryText,
} from "./voiceBookingHelpers";
import { twoSentencesMax } from "./speechFormatting";
import { handleBookingLocationStep } from "./booking/handleBookingLocationStep";
import { handleBookingDatetimeStep } from "./booking/handleBookingDatetimeStep";
import {
  assertNonEmptyBookingSpeech,
  createBookingGather,
  resolveBookingSpeechFast,
} from "./booking/bookingSpeech";
import { handleBookingConfirmationStep } from "./booking/handleBookingConfirmationStep";
import { handleBookingPhoneStep } from "./booking/handleBookingPhoneStep";
import { handleBookingServiceStep } from "./booking/handleBookingServiceStep";
import { handleBookingStepAdvance } from "./booking/handleBookingStepAdvance";
import { getCachedBookingFlow } from "./booking/bookingFlowCache";
export { clearVoiceBookingFlowCache } from "./booking/bookingFlowCache";

type ResolvedVoiceIntent =
  | "booking"
  | "prices"
  | "hours"
  | "location"
  | "human_handoff"
  | "unknown"
  | null;

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
    return handleBookingPhoneStep({
      vr,
      tenantId: tenant.id,
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
    });
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
    const serviceStepResult = await handleBookingServiceStep({
      vr,
      currentStep,
      currentLocale,
      voiceName,
      callerE164,
      effectiveUserInput,
      state,
      rawConfig: cfg?.booking_services_text || "",
      createBookingGather,
    });

    if (serviceStepResult.handled) {
      return {
        handled: true,
        state: serviceStepResult.state,
        twiml: serviceStepResult.twiml,
      };
    }

    state = serviceStepResult.state;
    resolvedStepValue = serviceStepResult.resolvedValue;
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

  return handleBookingStepAdvance({
    vr,
    tenantId: tenant.id,
    flow,
    currentStep,
    currentIndex,
    currentLocale,
    voiceName,
    callSid,
    callerE164,
    state,
    resolvedStepValue,
    isServiceStep,
    isDatetimeStep,
    createBookingGather,
    upsertVoiceCallState,
  });
}