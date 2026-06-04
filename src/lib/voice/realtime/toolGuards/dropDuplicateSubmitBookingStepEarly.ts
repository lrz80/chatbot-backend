//src/lib/voice/realtime/toolGuards/dropDuplicateSubmitBookingStepEarly.ts
import WebSocket from "ws";
import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";
import { sendRealtimeJson } from "../socket/sendRealtimeJson";
import { clean } from "../utils/clean";

type DropDuplicateSubmitBookingStepEarlyParams = {
  toolName: string;
  toolArgs: Record<string, any>;
  callId: string;
  callSid: string | null;
  openAiSocket: WebSocket;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
  isSyntheticToolCall: boolean;
  lastUserTranscript: string;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
};

type DropDuplicateSubmitBookingStepEarlyResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      result: RealtimeToolResult;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: false;
      callEnding: boolean;
      resetLastUserDigits: false;
    };

export function dropDuplicateSubmitBookingStepEarly(
  params: DropDuplicateSubmitBookingStepEarlyParams
): DropDuplicateSubmitBookingStepEarlyResult {
  const {
    toolName,
    toolArgs,
    callId,
    callSid,
    openAiSocket,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
    isSyntheticToolCall,
    lastUserTranscript,
    requestRealtimeResponse,
  } = params;

  if (toolName !== "submit_booking_step") {
    return { handled: false };
  }

  const submittedStepKey = clean(toolArgs.step_key);

  const lastUserTranscriptSeq =
    typeof realtimeState.lastUserTranscriptSeq === "number"
      ? realtimeState.lastUserTranscriptSeq
      : -1;

  const lastSubmittedBookingTranscriptSeq =
    typeof realtimeState.lastSubmittedBookingTranscriptSeq === "number"
      ? realtimeState.lastSubmittedBookingTranscriptSeq
      : -1;

  const lastSubmittedBookingStepKey = clean(
    realtimeState.lastSubmittedBookingStepKey || ""
  );

  const isAlreadySubmittedForCurrentTranscript =
    Boolean(submittedStepKey) &&
    Boolean(lastSubmittedBookingStepKey) &&
    submittedStepKey === lastSubmittedBookingStepKey &&
    lastUserTranscriptSeq >= 0 &&
    lastSubmittedBookingTranscriptSeq === lastUserTranscriptSeq;

  if (!isAlreadySubmittedForCurrentTranscript) {
    return { handled: false };
  }

  const result: RealtimeToolResult = {
    ok: false,
    error: "STALE_DUPLICATE_SUBMIT_DROPPED",
    next_required_step: realtimeState.pendingBookingStepKey
      ? {
          step_key: realtimeState.pendingBookingStepKey,
          prompt: realtimeState.pendingBookingStepPrompt || "",
          retry_prompt: realtimeState.pendingBookingStepPrompt || "",
          required: realtimeState.pendingBookingStepRequired ?? true,
        }
      : undefined,
  };

  console.warn("[VOICE_REALTIME][SUBMIT_BOOKING_STEP_DUPLICATE_DROPPED_EARLY]", {
    callSid,
    submittedStepKey,
    pendingBookingStepKey: realtimeState.pendingBookingStepKey || "",
    bookingTurnStatus: (realtimeState as any).bookingTurnStatus || "",
    lastUserTranscript,
    lastUserTranscriptSeq,
    lastSubmittedBookingStepKey,
    lastSubmittedBookingTranscriptSeq,
  });

  if (!isSyntheticToolCall) {
    sendRealtimeJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  }

  const currentStepPrompt = clean(realtimeState.pendingBookingStepPrompt || "");

  if (currentStepPrompt) {
    requestRealtimeResponse(
      {
        instructions: currentStepPrompt,
      },
      "tool_guard:duplicate_submit_current_step_prompt"
    );
  }

  return {
    handled: true,
    result,
    realtimeState,
    bookingFlowLoaded,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: false,
  };
}