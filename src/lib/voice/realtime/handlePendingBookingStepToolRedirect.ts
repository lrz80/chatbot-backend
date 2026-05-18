//src/lib/voice/realtime/handlePendingBookingStepToolRedirect.ts

import WebSocket from "ws";
import type { CallState } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";
import { type RealtimeToolResult } from "./buildToolFollowupInstructions";
import { resolveRealtimeToolFollowupInstructions } from "./toolFollowup/resolveRealtimeToolFollowupInstructions";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

type HandlePendingBookingStepToolRedirectParams = {
  originalToolName: string;
  originalToolArgs: Record<string, any>;
  callId: string;
  openAiSocket: WebSocket;
  requestRealtimeResponse: RequestRealtimeResponse;
  callSid: string | null;
  tenantId: string;
  callerPhone: string | null;
  didNumber: string | null;
  realtimeTenant: any;
  realtimeCfg: any;
  realtimeState: CallState;
  currentLocale: VoiceLocale;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
  lastUserTranscript: string;
  lastUserDigits: string;
};

type HandlePendingBookingStepToolRedirectResult = {
  handled: boolean;
  result?: RealtimeToolResult;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  hangupRequestedByTool: boolean;
  callEnding: boolean;
  resetLastUserDigits: boolean;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stepExpectsUserInput(step: Record<string, unknown> | null): boolean {
  if (!step) return false;

  const stepKey = clean(step.step_key || "");
  const slot = clean(step.slot || "");
  const expectedType = clean(step.expected_type || "");
  const required = step.required === true;

  if (!stepKey) return false;

  return (
    required ||
    expectedType === "confirmation" ||
    expectedType === "phone" ||
    expectedType === "datetime" ||
    expectedType === "number" ||
    (expectedType === "text" && slot !== "none")
  );
}

export async function handlePendingBookingStepToolRedirect(
  params: HandlePendingBookingStepToolRedirectParams
): Promise<HandlePendingBookingStepToolRedirectResult> {
  const {
    originalToolName,
    originalToolArgs,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    callSid,
    tenantId,
    callerPhone,
    didNumber,
    realtimeTenant,
    realtimeCfg,
    realtimeState,
    currentLocale,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
    lastUserDigits,
  } = params;

  const pendingStepKey = clean(
    realtimeState.pendingBookingStepKey || ""
  );

  const hasPendingBookingStep = Boolean(pendingStepKey);

  if (!hasPendingBookingStep) {
    return {
      handled: false,
      realtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: false,
    };
  }

  const redirectedValue = clean(lastUserTranscript || "");

  const redirectedToolArgs = {
    step_key: pendingStepKey,
    value: redirectedValue,
    raw_transcript_value: redirectedValue,
    model_value: redirectedValue,
  };

  console.warn("[VOICE_REALTIME][TOOL_REDIRECTED_TO_PENDING_BOOKING_STEP]", {
    callSid,
    originalToolName,
    redirectedToolName: "submit_booking_step",
    pendingStepKey,
    lastUserTranscript: clean(lastUserTranscript || ""),
  });

  const redirectedToolResult = await executeRealtimeTool({
    tenantId,
    callerPhone,
    toolName: "submit_booking_step",
    args: redirectedToolArgs,
    tenant: realtimeTenant,
    cfg: realtimeCfg,
    callSid: callSid || undefined,
    didNumber: didNumber || undefined,
    currentLocale,
    state: realtimeState,
    userInput: lastUserTranscript,
    digits: lastUserDigits,
  });

  const nextRequiredStep = getObject(redirectedToolResult?.next_required_step);

  const redirectedOk = redirectedToolResult?.ok === true;
  const nextRequiredStepExpectsUserInput = stepExpectsUserInput(nextRequiredStep);

  const resolvedPendingBookingStepKey =
    redirectedOk && nextRequiredStepExpectsUserInput
      ? clean(nextRequiredStep?.step_key || "") || undefined
      : redirectedOk
        ? undefined
        : pendingStepKey;

  const redirectedActionRequired = clean(
    (redirectedToolResult as any)?.action_required || ""
  );

  const shouldExecuteOriginalToolAfterRedirect =
    redirectedOk &&
    !nextRequiredStepExpectsUserInput &&
    redirectedActionRequired === originalToolName;

  const nextRealtimeState: CallState = {
    ...realtimeState,
    lang: currentLocale,

    pendingBookingStepKey: shouldExecuteOriginalToolAfterRedirect
      ? undefined
      : resolvedPendingBookingStepKey,

    pendingBookingStepRequired:
      shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : redirectedOk && nextRequiredStepExpectsUserInput
          ? nextRequiredStep?.required === true
          : realtimeState.pendingBookingStepRequired,

    pendingBookingStepSlot:
      shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : redirectedOk && nextRequiredStepExpectsUserInput
          ? clean(nextRequiredStep?.slot || "")
          : (realtimeState as any).pendingBookingStepSlot,

    pendingBookingStepExpectedType:
      shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : redirectedOk && nextRequiredStepExpectsUserInput
          ? clean(nextRequiredStep?.expected_type || "")
          : (realtimeState as any).pendingBookingStepExpectedType,

    pendingBookingStepPrompt:
      shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : redirectedOk && nextRequiredStepExpectsUserInput
          ? clean(nextRequiredStep?.prompt || "") || undefined
          : realtimeState.pendingBookingStepPrompt,

    pendingBookingStepPromptAnchorTranscript:
      shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : redirectedOk && nextRequiredStepExpectsUserInput
          ? clean(lastUserTranscript || "")
          : realtimeState.pendingBookingStepPromptAnchorTranscript,

    pendingBookingStepPromptAnchorSeq:
      shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : redirectedOk && nextRequiredStepExpectsUserInput
          ? realtimeState.lastUserTranscriptSeq
          : realtimeState.pendingBookingStepPromptAnchorSeq,

    lastSubmittedBookingStepKey:
      redirectedOk ? pendingStepKey : realtimeState.lastSubmittedBookingStepKey,

    lastSubmittedBookingTranscript:
      redirectedOk ? redirectedValue : realtimeState.lastSubmittedBookingTranscript,

    lastSubmittedBookingTranscriptSeq:
      redirectedOk
        ? realtimeState.lastUserTranscriptSeq
        : realtimeState.lastSubmittedBookingTranscriptSeq,

    pendingActionGranted: shouldExecuteOriginalToolAfterRedirect
      ? true
      : realtimeState.pendingActionGranted,

    pendingActionAnswered:
      redirectedToolResult?.ok === true
        ? true
        : realtimeState.pendingActionAnswered,

    pendingActionToolName: shouldExecuteOriginalToolAfterRedirect
      ? originalToolName
      : realtimeState.pendingActionToolName,
    } as CallState;

  console.log("[VOICE_REALTIME][TOOL_RESULT]", {
    callSid,
    toolName: "submit_booking_step",
    ok: redirectedToolResult?.ok,
    error: redirectedToolResult?.error,
    missing_required_slots: redirectedToolResult?.missing_required_slots,
    next_required_step: redirectedToolResult?.next_required_step,
    action_required: redirectedActionRequired || undefined,
  });

  if (shouldExecuteOriginalToolAfterRedirect) {
    console.warn("[VOICE_REALTIME][EXECUTING_ORIGINAL_TOOL_AFTER_PENDING_STEP]", {
      callSid,
      originalToolName,
      pendingStepKey,
      actionRequired: redirectedActionRequired,
    });

    const actionToolResult = await executeRealtimeTool({
      tenantId,
      callerPhone,
      toolName: originalToolName,
      args: originalToolArgs,
      tenant: realtimeTenant,
      cfg: realtimeCfg,
      callSid: callSid || undefined,
      didNumber: didNumber || undefined,
      currentLocale,
      state: nextRealtimeState,
      userInput: lastUserTranscript,
      digits: lastUserDigits,
    });

    const finalRealtimeState: CallState = {
      ...nextRealtimeState,

      pendingBookingStepKey: undefined,
      pendingBookingStepRequired: undefined,
      pendingBookingStepSlot: undefined,
      pendingBookingStepExpectedType: undefined,
      pendingBookingStepPrompt: undefined,
      pendingBookingStepPromptAnchorTranscript: undefined,
      pendingBookingStepPromptAnchorSeq: undefined,

      pendingActionGranted: undefined,
      pendingActionAnswered: true,
      pendingActionToolName: undefined,

      awaitingPostBookingClosure:
        actionToolResult?.ok === true
        ? true
        : nextRealtimeState.awaitingPostBookingClosure,

      postBookingClosureTranscript:
        actionToolResult?.ok === true
        ? clean(lastUserTranscript || "")
        : nextRealtimeState.postBookingClosureTranscript,

      postBookingClosureTranscriptSeq:
        actionToolResult?.ok === true
        ? realtimeState.lastUserTranscriptSeq
        : (nextRealtimeState as any).postBookingClosureTranscriptSeq,
    } as CallState;

    console.log("[VOICE_REALTIME][TOOL_RESULT]", {
      callSid,
      toolName: originalToolName,
      ok: actionToolResult?.ok,
      error: actionToolResult?.error,
      missing_required_slots: actionToolResult?.missing_required_slots,
      next_required_step: actionToolResult?.next_required_step,
    });

    sendJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(actionToolResult),
      },
    });

    requestRealtimeResponse(
      {
        instructions: resolveRealtimeToolFollowupInstructions({
          toolName: originalToolName,
          toolResult: (actionToolResult || {}) as RealtimeToolResult,
        }),
      },
      `tool_followup:${originalToolName}`
    );

    return {
      handled: true,
      result: actionToolResult as RealtimeToolResult,
      realtimeState: finalRealtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: true,
    };
  }

  sendJson(openAiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(redirectedToolResult),
    },
  });

  requestRealtimeResponse(
    {
      instructions: resolveRealtimeToolFollowupInstructions({
        toolName: "submit_booking_step",
        toolResult: (redirectedToolResult || {}) as RealtimeToolResult,
      }),
    },
    "tool_followup:submit_booking_step"
  );

  return {
    handled: true,
    result: redirectedToolResult as RealtimeToolResult,
    realtimeState: nextRealtimeState,
    bookingFlowLoaded,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: true,
  };
}