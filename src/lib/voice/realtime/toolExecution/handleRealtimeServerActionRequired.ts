//src/lib/voice/realtime/toolExecution/handleRealtimeServerActionRequired.ts
import type { CallState } from "../../types";
import { executeRealtimeTool } from "../realtimeToolExecutor";
import type { RealtimeToolResult } from "../toolTypes";
import { clean } from "../utils/clean";
import { buildExactRealtimeSpeechResponse } from "../buildExactRealtimeSpeechResponse";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

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

const SERVER_EXECUTABLE_ACTIONS = new Set(["create_appointment"]);

function clearConsumedPendingAction(state: CallState): CallState {
  const nextState = {
    ...state,
  } as any;

  delete nextState.pendingActionGranted;
  delete nextState.pendingActionAnswered;
  delete nextState.pendingActionToolName;

  return nextState as CallState;
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

  if (!stepKey || !prompt) {
    return state;
  }

  return {
    ...state,
    pendingBookingStepKey: stepKey,
    pendingBookingStepPrompt: prompt,
    pendingBookingStepRequired: required,
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
    actionRequired === "create_appointment"
      ? clearConsumedPendingAction(nextRealtimeState)
      : nextRealtimeState;

  const finalRealtimeState = applyServerActionNextRequiredStep(
    baseFinalRealtimeState,
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

    requestRealtimeResponse(
      buildExactRealtimeSpeechResponse({
        prompt: finalFollowupInstructions,
        currentLocale: finalLocale,
      }),
      `tool_followup:${actionRequired}`
    );
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