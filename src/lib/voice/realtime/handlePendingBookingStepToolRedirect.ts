//src/lib/voice/realtime/handlePendingBookingStepToolRedirect.ts

import WebSocket from "ws";
import type { CallState } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";
import {
  buildToolFollowupInstructions,
  type RealtimeToolResult,
} from "./buildToolFollowupInstructions";

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

  const redirectedToolArgs = {
    step_key: pendingStepKey,
    value: clean(lastUserTranscript || ""),
    raw_transcript_value: clean(lastUserTranscript || ""),
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

  const resolvedPendingBookingStepKey =
    clean(nextRequiredStep?.step_key || "") || undefined;

  const redirectedActionRequired = clean(
    (redirectedToolResult as any)?.action_required || ""
  );

  const shouldExecuteOriginalToolAfterRedirect =
    redirectedToolResult?.ok === true &&
    !nextRequiredStep &&
    (
        !redirectedActionRequired ||
        redirectedActionRequired === originalToolName
    );

  const nextRealtimeState: CallState = {
    ...realtimeState,
    lang: currentLocale,

    pendingBookingStepKey: shouldExecuteOriginalToolAfterRedirect
        ? undefined
        : resolvedPendingBookingStepKey,

    pendingBookingStepRequired:
        shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : nextRequiredStep?.required === true,

    pendingBookingStepPrompt:
        shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : clean(nextRequiredStep?.prompt || "") || undefined,

    pendingBookingStepPromptAnchorTranscript:
        shouldExecuteOriginalToolAfterRedirect || !resolvedPendingBookingStepKey
        ? undefined
        : clean(lastUserTranscript || ""),

    lastSubmittedBookingStepKey: pendingStepKey,
    lastSubmittedBookingTranscript: clean(lastUserTranscript || ""),

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
      pendingBookingStepPrompt: undefined,
      pendingBookingStepPromptAnchorTranscript: undefined,

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
        instructions: buildToolFollowupInstructions({
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
      instructions: buildToolFollowupInstructions({
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