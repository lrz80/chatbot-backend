// src/lib/voice/realtime/toolGuards/bootstrapSubmitBookingStepAfterFlowLoad.ts
import type WebSocket from "ws";
import type { CallState, VoiceLocale } from "../../types";
import { executeRealtimeTool } from "../realtimeToolExecutor";
import type { RealtimeToolResult } from "../toolTypes";
import { buildNextRealtimeStateFromToolResult } from "../toolState/buildNextRealtimeStateFromToolResult";
import { applyBookingRuntimeStateAfterToolResult } from "../bookingRuntimeState";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

export type BootstrapSubmitBookingStepAfterFlowLoadResult =
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
      resetLastUserDigits: boolean;
    };

type BootstrapSubmitBookingStepAfterFlowLoadArgs = {
  toolArgs: Record<string, any>;
  callId: string;
  callSid: string | null;
  openAiSocket: WebSocket;
  requestRealtimeResponse: RequestRealtimeResponse;

  tenantId: string;
  callerPhone: string | null;
  didNumber: string | null;
  tenant: any;
  cfg: any;

  realtimeState: CallState;
  currentLocale: VoiceLocale;
  callEnding: boolean;
  lastUserTranscript: string;
  lastUserDigits: string;

  isSyntheticToolCall: boolean;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function sendToolOutputIfNeeded(params: {
  openAiSocket: WebSocket;
  callId: string;
  isSyntheticToolCall: boolean;
  output: unknown;
}): void {
  if (params.isSyntheticToolCall) {
    return;
  }

  sendJson(params.openAiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: params.callId,
      output: JSON.stringify(params.output),
    },
  });
}

function resolveBootstrapSubmitFollowupInstructions(
  submitResult: RealtimeToolResult
): string {
  const result = submitResult || {};

  const retryPrompt =
    clean((result as any)?.next_required_step?.retry_prompt || "") ||
    clean((result as any)?.retry_prompt || "");

  if ((result as any)?.ok === false && retryPrompt) {
    return retryPrompt;
  }

  const nextRequiredPrompt = clean(
    (result as any)?.next_required_step?.prompt || ""
  );

  if (nextRequiredPrompt) {
    return nextRequiredPrompt;
  }

  const unavailablePrompt =
    clean((result as any)?.unavailable_prompt || "") ||
    clean((result as any)?.next_required_step?.unavailable_prompt || "");

  if (unavailablePrompt) {
    return unavailablePrompt;
  }

  return (
    clean((result as any)?.response_message || "") ||
    clean((result as any)?.message || "") ||
    clean((result as any)?.instructions || "")
  );
}

export async function bootstrapSubmitBookingStepAfterFlowLoad(
  params: BootstrapSubmitBookingStepAfterFlowLoadArgs
): Promise<BootstrapSubmitBookingStepAfterFlowLoadResult> {
  const submittedStepKey = clean(params.toolArgs.step_key);
  const submittedValue = clean(params.toolArgs.value);

  if (!submittedStepKey || !submittedValue) {
    return {
      handled: false,
    };
  }

  console.warn("[VOICE_REALTIME][BOOKING_FLOW_BOOTSTRAP_BEFORE_SUBMIT]", {
    callSid: params.callSid,
    submittedStepKey,
    submittedValue,
  });

  const flowResult = await executeRealtimeTool({
    tenantId: params.tenantId,
    callerPhone: params.callerPhone,
    toolName: "get_booking_flow",
    args: {},
    tenant: params.tenant,
    cfg: params.cfg,
    callSid: params.callSid || undefined,
    didNumber: params.didNumber || undefined,
    currentLocale: params.currentLocale,
    state: params.realtimeState,
    userInput: params.lastUserTranscript,
    digits: params.lastUserDigits,
  });

  if (!flowResult?.ok) {
    const blockedResult: RealtimeToolResult = {
      ok: false,
      error: "BOOKING_FLOW_NOT_LOADED",
    };

    sendToolOutputIfNeeded({
      openAiSocket: params.openAiSocket,
      callId: params.callId,
      isSyntheticToolCall: params.isSyntheticToolCall,
      output: blockedResult,
    });

    return {
      handled: true,
      result: blockedResult,
      realtimeState: params.realtimeState,
      bookingFlowLoaded: false,
      hangupRequestedByTool: false,
      callEnding: params.callEnding,
      resetLastUserDigits: false,
    };
  }

  const flowNextStateBase = buildNextRealtimeStateFromToolResult({
    realtimeState: params.realtimeState,
    toolName: "get_booking_flow",
    toolResult: flowResult,
    effectiveToolArgs: {},
    currentLocale: params.currentLocale,
    lastUserTranscript: params.lastUserTranscript,
  });

  const flowNextState = applyBookingRuntimeStateAfterToolResult({
    realtimeState: flowNextStateBase,
    toolName: "get_booking_flow",
    toolResult: flowResult,
    effectiveToolArgs: {},
    lastUserTranscript: params.lastUserTranscript,
  });

  const nextRequiredStepKey = clean(flowResult?.next_required_step?.step_key);

  if (nextRequiredStepKey && nextRequiredStepKey !== submittedStepKey) {
    const blockedResult: RealtimeToolResult = {
      ok: false,
      error: "BOOKING_BOOTSTRAP_STEP_MISMATCH",
      next_required_step: flowResult.next_required_step ?? null,
    };

    console.warn("[VOICE_REALTIME][BOOKING_BOOTSTRAP_STEP_MISMATCH]", {
      callSid: params.callSid,
      submittedStepKey,
      nextRequiredStepKey,
    });

    sendToolOutputIfNeeded({
      openAiSocket: params.openAiSocket,
      callId: params.callId,
      isSyntheticToolCall: params.isSyntheticToolCall,
      output: blockedResult,
    });

    return {
      handled: true,
      result: blockedResult,
      realtimeState: flowNextState,
      bookingFlowLoaded: true,
      hangupRequestedByTool: false,
      callEnding: params.callEnding,
      resetLastUserDigits: false,
    };
  }

  const submitArgs = {
    ...params.toolArgs,
    step_key: submittedStepKey,
    value: submittedValue,
    model_value: submittedValue,
    transcript_value: params.lastUserTranscript,
    value_candidates: [
      {
        source: "model",
        value: submittedValue,
      },
    ],
  };

  const submitResult = await executeRealtimeTool({
    tenantId: params.tenantId,
    callerPhone: params.callerPhone,
    toolName: "submit_booking_step",
    args: submitArgs,
    tenant: params.tenant,
    cfg: params.cfg,
    callSid: params.callSid || undefined,
    didNumber: params.didNumber || undefined,
    currentLocale: params.currentLocale,
    state: flowNextState,
    userInput: params.lastUserTranscript,
    digits: params.lastUserDigits,
  });

  const submitNextStateBase = buildNextRealtimeStateFromToolResult({
    realtimeState: flowNextState,
    toolName: "submit_booking_step",
    toolResult: submitResult,
    effectiveToolArgs: submitArgs,
    currentLocale: params.currentLocale,
    lastUserTranscript: params.lastUserTranscript,
  });

  const submitNextState = applyBookingRuntimeStateAfterToolResult({
    realtimeState: submitNextStateBase,
    toolName: "submit_booking_step",
    toolResult: submitResult,
    effectiveToolArgs: submitArgs,
    lastUserTranscript: params.lastUserTranscript,
  });

  console.log("[VOICE_REALTIME][BOOKING_FLOW_BOOTSTRAP_SUBMIT_RESULT]", {
    callSid: params.callSid,
    submittedStepKey,
    ok: submitResult?.ok,
    error: submitResult?.error,
    next_required_step: submitResult?.next_required_step,
  });

  sendToolOutputIfNeeded({
    openAiSocket: params.openAiSocket,
    callId: params.callId,
    isSyntheticToolCall: params.isSyntheticToolCall,
    output: submitResult,
  });

  const followupInstructions = resolveBootstrapSubmitFollowupInstructions(
    (submitResult || {}) as RealtimeToolResult
  );

  if (followupInstructions) {
    params.requestRealtimeResponse(
      {
        instructions: followupInstructions,
      },
      "tool_followup:submit_booking_step"
    );
  }

  return {
    handled: true,
    result: submitResult as RealtimeToolResult,
    realtimeState: submitNextState,
    bookingFlowLoaded: true,
    hangupRequestedByTool: false,
    callEnding: params.callEnding,
    resetLastUserDigits: true,
  };
}