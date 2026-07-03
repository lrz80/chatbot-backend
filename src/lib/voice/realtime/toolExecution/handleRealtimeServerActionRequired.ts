// src/lib/voice/realtime/toolExecution/handleRealtimeServerActionRequired.ts
import type { CallState, VoiceLocale } from "../../types";
import { executeRealtimeTool } from "../realtimeToolExecutor";
import type { RealtimeToolResult } from "../toolTypes";
import { clean } from "../utils/clean";
import { buildI18nBookingFinalResponse } from "../i18n/buildI18nBookingFinalResponse";
import {
  getBookingLockedLanguageSample,
  getBookingLockedLocale,
} from "../bookingTurnState";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

type HandleRealtimeServerActionRequiredParams = {
  toolName: string;
  toolResult: RealtimeToolResult;
  actionRequired: string;
  resolvedTenantId: string;
  callerPhone: string | null;
  didNumber: string | null;
  realtimeTenant: any;
  realtimeCfg: any;
  callSid: string | null;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  nextRealtimeState: CallState;
  bookingFlowLoaded: boolean;
  nextBookingFlowLoaded: boolean;
  callEnding: boolean;
  nextCallEnding: boolean;
  lastUserTranscript: string;
  lastUserDigits: string;
  requestRealtimeResponse: RequestRealtimeResponse;
};

type HandleRealtimeServerActionRequiredResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      result: RealtimeToolResult;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: boolean;
      callEnding: boolean;
      resetLastUserDigits: true;
    };

const SERVER_EXECUTABLE_ACTIONS = new Set([
  "create_appointment",
  "send_booking_sms",
]);

function clearConsumedPendingAction(state: CallState): CallState {
  const nextState = {
    ...state,
  } as any;

  delete nextState.pendingActionGranted;
  delete nextState.pendingActionAnswered;
  delete nextState.pendingActionToolName;

  return nextState as CallState;
}

function applyServerActionPostBookingClosureState(params: {
  state: CallState;
  actionRequired: string;
  serverActionResult: RealtimeToolResult;
  lastUserTranscript: string;
}): CallState {
  const { state, actionRequired, serverActionResult, lastUserTranscript } =
    params;

  if (
    (actionRequired === "create_appointment" ||
      actionRequired === "send_booking_sms") &&
    serverActionResult?.ok === true
  ) {
    return {
      ...(state as any),
      awaitingPostBookingClosure: true,
      postBookingClosureTranscript: clean(lastUserTranscript),
      postBookingClosureTranscriptSeq: (state as any)?.lastUserTranscriptSeq,
    } as CallState;
  }

  return state;
}

function applyServerActionNextRequiredStep(
  state: CallState,
  serverActionResult: RealtimeToolResult
): CallState {
  const nextStep = (serverActionResult as any)?.next_required_step;

  if (!nextStep || typeof nextStep !== "object") {
    return state;
  }

  const stepKey = clean(nextStep.step_key || "");
  const prompt = clean(nextStep.prompt || "");
  const required = nextStep.required === true;
  const expectedType = clean(nextStep.expected_type || "");

  if (!stepKey || !prompt) {
    return state;
  }

  return {
    ...state,
    pendingBookingStepKey: stepKey,
    pendingBookingStepPrompt: prompt,
    pendingBookingStepRequired: required,
    pendingBookingStepExpectedType: expectedType,
    bookingTurnStatus: "waiting_assistant_prompt",
    next_required_step: nextStep,
  } as CallState;
}

function resolveServerActionFollowupInstructions(
  serverActionResult: RealtimeToolResult
): string {
  const result = serverActionResult || {};

  const retryPrompt =
    clean((result as any)?.next_required_step?.retry_prompt || "") ||
    clean((result as any)?.retry_prompt || "");

  if ((result as any)?.ok === false && retryPrompt) {
    return retryPrompt;
  }

  const assistantPrompt = clean((result as any)?.assistant_prompt || "");

  if (assistantPrompt) {
    return assistantPrompt;
  }

  const responseMessage =
    clean((result as any)?.response_message || "") ||
    clean((result as any)?.message || "") ||
    clean((result as any)?.instructions || "");

  if (responseMessage) {
    return responseMessage;
  }

  return clean((result as any)?.next_required_step?.prompt || "");
}

export async function handleRealtimeServerActionRequired(
  params: HandleRealtimeServerActionRequiredParams
): Promise<HandleRealtimeServerActionRequiredResult> {
  const {
    toolName,
    toolResult,
    actionRequired,
    resolvedTenantId,
    callerPhone,
    didNumber,
    realtimeTenant,
    realtimeCfg,
    callSid,
    currentLocale,
    realtimeState,
    nextRealtimeState,
    nextBookingFlowLoaded,
    nextCallEnding,
    lastUserTranscript,
    lastUserDigits,
    requestRealtimeResponse,
  } = params;

  if (
    toolName !== "submit_booking_step" ||
    toolResult?.ok !== true ||
    !SERVER_EXECUTABLE_ACTIONS.has(actionRequired)
  ) {
    return { handled: false };
  }

  console.warn("[VOICE_REALTIME][SERVER_ACTION_REQUIRED_EXECUTING]", {
    callSid,
    toolName,
    actionRequired,
  });

  const serverActionResult = await executeRealtimeTool({
    tenantId: resolvedTenantId,
    callerPhone,
    toolName: actionRequired,
    args: {},
    tenant: realtimeTenant,
    cfg: realtimeCfg,
    callSid: callSid || undefined,
    didNumber: didNumber || undefined,
    currentLocale,
    state: nextRealtimeState,
    userInput: lastUserTranscript,
    digits: lastUserDigits,
  });

  console.log("[VOICE_REALTIME][SERVER_ACTION_RESULT]", {
    callSid,
    actionRequired,
    ok: serverActionResult?.ok,
    error: serverActionResult?.error,
    message: serverActionResult?.message,
  });

  const baseFinalRealtimeState =
    actionRequired === "create_appointment" ||
    actionRequired === "send_booking_sms"
      ? clearConsumedPendingAction(nextRealtimeState)
      : nextRealtimeState;

  const postBookingFinalRealtimeState =
    applyServerActionPostBookingClosureState({
      state: baseFinalRealtimeState,
      actionRequired,
      serverActionResult: (serverActionResult || {}) as RealtimeToolResult,
      lastUserTranscript,
    });

  const finalRealtimeState = applyServerActionNextRequiredStep(
    postBookingFinalRealtimeState,
    (serverActionResult || {}) as RealtimeToolResult
  );

  const finalFollowupInstructions = resolveServerActionFollowupInstructions(
    (serverActionResult || {}) as RealtimeToolResult
  );

  if (finalFollowupInstructions) {
    const finalLocale =
      clean((finalRealtimeState as any)?.lang) ||
      clean((nextRealtimeState as any)?.lang) ||
      currentLocale;

    const bookingLanguage = clean(
      (finalRealtimeState as any).conversationLanguage ||
        (nextRealtimeState as any).conversationLanguage ||
        (realtimeState as any).conversationLanguage ||
        ""
    );

    if (actionRequired === "send_booking_sms") {
      requestRealtimeResponse(
        {
          tool_choice: "none",
          instructions: [
            "You are continuing a live phone conversation after a booking SMS was sent.",
            "Tell the caller that the SMS was sent.",
            "Then ask whether they need anything else.",
            "Use the caller's active language.",
            `The active language is ${finalLocale}.`,
            `Backend SMS result message: ${JSON.stringify(
              finalFollowupInstructions
            )}`,
            "Do not mention tools.",
            "Do not call any tool.",
          ].join("\n"),
        },
        `tool_followup:${actionRequired}`
      );
    } else {
      requestRealtimeResponse(
        buildI18nBookingFinalResponse({
          message: finalFollowupInstructions,
          currentLocale: finalLocale,
          lastAssistantTranscript: clean(
            (finalRealtimeState as any).lastAssistantTranscript ||
              (nextRealtimeState as any).lastAssistantTranscript ||
              (realtimeState as any).lastAssistantTranscript ||
              ""
          ),
          bookingLanguage,
          bookingLockedLocale: getBookingLockedLocale(finalRealtimeState),
          bookingLockedLanguageSample:
            getBookingLockedLanguageSample(finalRealtimeState),
        }),
        `tool_followup:${actionRequired}`
      );
    }
  }

  return {
    handled: true,
    result: serverActionResult as RealtimeToolResult,
    realtimeState: finalRealtimeState,
    bookingFlowLoaded: nextBookingFlowLoaded,
    hangupRequestedByTool:
      actionRequired === "end_call" && serverActionResult?.ok === true,
    callEnding: nextCallEnding,
    resetLastUserDigits: true,
  };
}