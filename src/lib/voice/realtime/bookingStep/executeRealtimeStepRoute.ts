// src/lib/voice/realtime/bookingStep/executeRealtimeStepRoute.ts
import type { CallState, VoiceLocale } from "../../types";
import type {
  BookingFlowStepLike,
  BookingState,
} from "../realtimeBookingFlowUtils";
import { buildRealtimeStepWorkingState } from "./buildRealtimeStepWorkingState";
import { routeRealtimeBookingStep } from "./routeRealtimeBookingStep";
import { handleBookingServiceRealtimeStep } from "../handlers/handleBookingServiceRealtimeStep";
import { handleDatetimeRealtimeStep } from "./handlers/handleDatetimeRealtimeStep";
import { handleStaffRealtimeStep } from "./handlers/handleStaffRealtimeStep";
import { handleGenericRealtimeStep } from "./handlers/handleGenericRealtimeStep";
import { handlePostBookingSmsConsentStep } from "../handlers/handlePostBookingSmsConsentStep";
import { handlePostBookingGenericStep } from "../handlers/handlePostBookingGenericStep";
import { handleFinalBookingConfirmationStep } from "../handlers/handleFinalBookingConfirmationStep";

type ExecuteRealtimeStepRouteParams = {
  tenantId: string;
  callerPhone: string | null;
  bookingContext: {
    tenant: any;
    cfg: any;
    callSid: string;
    didNumber: string;
    currentLocale: VoiceLocale;
    state: CallState;
    userInput: string;
    digits: string;
  };
  steps: BookingFlowStepLike[];
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  targetSlot: string;
  stepKey: string;
  resolvedInputValue: string;
  rawTranscriptValue: string;
  modelValue: string;
  sanitizedArgs: Record<string, any>;
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
  persistVoiceState: (params: {
    tenantId: string;
    callSid: string;
    state: CallState;
    locale: VoiceLocale;
  }) => Promise<void>;
};

export type ExecuteRealtimeStepRouteResult =
  | {
      kind: "continue";
      workingState: CallState;
    }
  | {
      kind: "return";
      result: any;
    };

export async function executeRealtimeStepRoute(
  params: ExecuteRealtimeStepRouteParams
): Promise<ExecuteRealtimeStepRouteResult> {
  const {
    tenantId,
    callerPhone,
    bookingContext,
    steps,
    currentStep,
    currentIndex,
    targetSlot,
    stepKey,
    resolvedInputValue,
    rawTranscriptValue,
    modelValue,
    sanitizedArgs,
    buildRealtimeBookingState,
    persistVoiceState,
  } = params;

  const stepWorkingState = buildRealtimeStepWorkingState({
    args: sanitizedArgs,
    callerPhone,
    state: bookingContext.state,
    steps,
    currentIndex,
  });

  const rawAnswers = stepWorkingState.rawAnswers;
  let workingState = stepWorkingState.workingState;

  const stepRoute = routeRealtimeBookingStep({
    currentStep,
    workingState,
  });

  if (stepRoute.kind === "service") {
    const serviceStepResult = await handleBookingServiceRealtimeStep({
      tenantId,
      callerPhone,
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      value: resolvedInputValue,
      targetSlot,
      stepKey,
      rawAnswers,
      workingState,
      rawConfig: bookingContext.cfg?.booking_services_text || "",
      steps,
      buildRealtimeBookingState,
    });

    if (serviceStepResult.kind === "return") {
      return {
        kind: "return",
        result: serviceStepResult.result,
      };
    }

    workingState = serviceStepResult.workingState;
  } else if (stepRoute.kind === "datetime") {
    const datetimeStepResult = await handleDatetimeRealtimeStep({
      tenantId,
      callSid: bookingContext.callSid,
      callerPhone,
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      targetSlot,
      stepKey,
      rawAnswers,
      workingState,
      resolvedInputValue,
      modelValue,
      rawTranscriptValue,
      steps,
      buildRealtimeBookingState,
    });

    if (datetimeStepResult.kind === "return") {
      return {
        kind: "return",
        result: datetimeStepResult.result,
      };
    }

    workingState = datetimeStepResult.workingState;
  } else if (stepRoute.kind === "staff") {
    const staffStepResult = await handleStaffRealtimeStep({
      tenantId,
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      targetSlot,
      stepKey,
      resolvedInputValue,
      rawTranscriptValue,
      modelValue,
      rawAnswers,
      workingState,
      steps,
      buildRealtimeBookingState,
    });

    if (staffStepResult.kind === "return") {
      return {
        kind: "return",
        result: staffStepResult.result,
      };
    }

    workingState = staffStepResult.workingState;
  } else if (stepRoute.kind === "post_booking_sms_consent") {
    return {
      kind: "return",
      result: await handlePostBookingSmsConsentStep({
        tenantId,
        callerPhone,
        stepKey,
        targetSlot,
        currentStep,
        currentIndex,
        rawAnswers,
        workingState,
        bookingContext,
        steps,
        args: sanitizedArgs,
        buildRealtimeBookingState,
        persistVoiceState,
      }),
    };
  } else if (stepRoute.kind === "post_booking_generic") {
    workingState = handlePostBookingGenericStep({
      stepKey,
      targetSlot,
      currentStep,
      currentIndex,
      rawAnswers,
      workingState,
      value: resolvedInputValue,
    });
  } else if (stepRoute.kind === "final_confirmation_before_create") {
    return {
      kind: "return",
      result: await handleFinalBookingConfirmationStep({
        tenantId,
        stepKey,
        targetSlot,
        currentStep,
        currentIndex,
        rawAnswers,
        workingState,
        bookingContext,
        steps,
        value: resolvedInputValue,
        buildRealtimeBookingState,
        persistVoiceState,
      }),
    };
  } else {
    const genericStepResult = handleGenericRealtimeStep({
      currentStep,
      currentIndex,
      currentLocale: bookingContext.currentLocale,
      targetSlot,
      stepKey,
      resolvedInputValue,
      modelValue,
      callerPhone,
      rawAnswers,
      workingState,
      steps,
      buildRealtimeBookingState,
    });

    if (genericStepResult.kind === "return") {
      return {
        kind: "return",
        result: genericStepResult.result,
      };
    }

    workingState = genericStepResult.workingState;
  }

  return {
    kind: "continue",
    workingState,
  };
}