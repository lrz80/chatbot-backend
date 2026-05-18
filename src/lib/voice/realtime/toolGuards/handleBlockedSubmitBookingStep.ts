// src/lib/voice/realtime/toolGuards/handleBlockedSubmitBookingStep.ts
import WebSocket from "ws";
import type { CallState } from "../../types";
import type {
  SubmitBookingStepFreshnessResult,
} from "./validateSubmitBookingStepFreshness";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";

type BlockedFreshness = Extract<
  SubmitBookingStepFreshnessResult,
  { ok: false }
>;

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function buildBlockedBookingStepResult(error: string): RealtimeToolResult {
  return {
    ok: false,
    error,
    message: error,
  };
}

export function handleBlockedSubmitBookingStep(params: {
  callSid: string | null;
  callId: string;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
  freshness: BlockedFreshness;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
}): {
  consumed: true;
  result: RealtimeToolResult;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  hangupRequestedByTool: false;
  callEnding: boolean;
  resetLastUserDigits: false;
} {
  const {
    callSid,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    freshness,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  } = params;

  const blockedResult = buildBlockedBookingStepResult(freshness.error);

  console.warn(
    "[VOICE_REALTIME][BOOKING_STEP_SUBMIT_BLOCKED_STALE_OR_DUPLICATE_INPUT]",
    {
      callSid,
      submittedStepKey: freshness.submittedStepKey,
      pendingStepKey: freshness.pendingStepKey,
      currentTranscript: freshness.currentTranscript,
      promptAnchorTranscript: freshness.promptAnchorTranscript,
      lastSubmittedStepKey: freshness.lastSubmittedStepKey,
      lastSubmittedTranscript: freshness.lastSubmittedTranscript,
      hasPendingStepState: freshness.hasPendingStepState,
      hasPromptAnchorTranscript: freshness.hasPromptAnchorTranscript,
      isSubmittingExpectedPendingStep: freshness.isSubmittingExpectedPendingStep,
      currentTranscriptSeq: freshness.currentTranscriptSeq,
      promptAnchorSeq: freshness.promptAnchorSeq,
      lastSubmittedTranscriptSeq: freshness.lastSubmittedTranscriptSeq,
      hasNewHumanTranscript: freshness.hasNewHumanTranscript,
      isDuplicateSubmit: freshness.isDuplicateSubmit,
      shouldBlockStaleSubmit: freshness.shouldBlockStaleSubmit,
    }
  );

  sendJson(openAiSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(blockedResult),
    },
  });

  requestRealtimeResponse(
    {
      instructions: [
        "Use only the tool result as source of truth.",
        "Do not call submit_booking_step again yet.",
        "The caller has not provided a new answer for the current booking step after the latest question.",
        "Repeat the current pending booking question naturally and briefly.",
        "Do not apologize excessively.",
        "Do not mention an error.",
        "Do not advance to another booking step.",
        "Wait for the caller to answer.",
      ].join(" "),
    },
    "tool_guard:booking_step_invalid_or_duplicate_input"
  );

  return {
    consumed: true,
    result: blockedResult,
    realtimeState,
    bookingFlowLoaded,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: false,
  };
}