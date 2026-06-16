// src/lib/voice/realtime/toolGuards/handleBlockedSubmitBookingStep.ts
import WebSocket from "ws";
import type { CallState } from "../../types";
import type {
  SubmitBookingStepFreshnessResult,
} from "./validateSubmitBookingStepFreshness";
import type { RealtimeToolResult } from "../toolTypes";

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