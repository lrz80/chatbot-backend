// src/lib/voice/realtime/toolFollowup/resolveSyntheticDirectBookingFollowup.ts

import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";
import { clean } from "../utils/clean";
import { resolveSyntheticSubmitBookingStepFollowup } from "./resolveSyntheticSubmitBookingStepFollowup";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type BookingNextRequiredStep = {
  step_key?: unknown;
  prompt?: unknown;
  required?: unknown;
};

type MutableRealtimeBookingState = CallState & {
  bookingTurnStatus?: string;
  pendingBookingStepKey?: string;
  pendingBookingStepPrompt?: string;
  pendingBookingStepRequired?: boolean;
  pendingBookingStepPromptAnchorSeq?: number;
  lastSubmittedBookingTranscriptSeq?: number;
  lastUserTranscriptSeq?: number;
};

export type SyntheticDirectBookingFollowupResolution = {
  shouldForceDirectFollowup: boolean;
  instructions: string;
  source: string;
  nextRealtimeState: CallState;
  logPayload: {
    toolName: string;
    callId: string;
    nextRequiredStepKey: string;
    nextRequiredPrompt: string;
    source: string;
    bookingTurnStatus: string;
    pendingBookingStepPromptAnchorSeq: number | null;
  };
};

function resolvePromptAnchorSeq(state: MutableRealtimeBookingState): number | undefined {
  if (typeof state.lastSubmittedBookingTranscriptSeq === "number") {
    return state.lastSubmittedBookingTranscriptSeq;
  }

  if (typeof state.lastUserTranscriptSeq === "number") {
    return state.lastUserTranscriptSeq;
  }

  if (typeof state.pendingBookingStepPromptAnchorSeq === "number") {
    return state.pendingBookingStepPromptAnchorSeq;
  }

  return undefined;
}

export function resolveSyntheticDirectBookingFollowup(params: {
  toolName: string;
  callId: string;
  toolResult: RealtimeToolResult;
  nextRealtimeState: CallState;
  currentLocale: VoiceLocale | string;
}): SyntheticDirectBookingFollowupResolution | null {
  const toolName = clean(params.toolName);

  if (toolName !== "submit_booking_step") {
    return null;
  }

  const nextRequiredStep = params.toolResult?.next_required_step as
    | BookingNextRequiredStep
    | undefined;

  const nextRequiredStepKey = clean(nextRequiredStep?.step_key || "");
  const nextRequiredPrompt = clean(nextRequiredStep?.prompt || "");

  if (!nextRequiredStepKey || !nextRequiredPrompt) {
    return null;
  }

  const instructions = resolveSyntheticSubmitBookingStepFollowup({
    toolName,
    toolResult: params.toolResult,
    currentLocale: params.currentLocale,
  });

  if (!instructions) {
    return null;
  }

  const source = `tool_followup:${toolName}:synthetic_direct`;

  /**
   * Synthetic tool calls do not send function_call_output back to OpenAI.
   * Because of that, the runtime itself must own the state transition.
   *
   * The next_required_step is already the source of truth from the booking engine.
   * This module only maps that truth into the realtime turn state.
   */
  const nextRealtimeState = {
    ...params.nextRealtimeState,
  } as MutableRealtimeBookingState;

  const nextAnchorSeq = resolvePromptAnchorSeq(nextRealtimeState);

  nextRealtimeState.pendingBookingStepKey = nextRequiredStepKey;
  nextRealtimeState.pendingBookingStepPrompt = nextRequiredPrompt;
  nextRealtimeState.pendingBookingStepRequired =
    typeof nextRequiredStep?.required === "boolean"
      ? nextRequiredStep.required
      : true;
  nextRealtimeState.bookingTurnStatus = "waiting_user_answer";

  if (typeof nextAnchorSeq === "number") {
    nextRealtimeState.pendingBookingStepPromptAnchorSeq = nextAnchorSeq;
  }

  return {
    shouldForceDirectFollowup: true,
    instructions,
    source,
    nextRealtimeState,
    logPayload: {
      toolName,
      callId: clean(params.callId),
      nextRequiredStepKey,
      nextRequiredPrompt,
      source,
      bookingTurnStatus: "waiting_user_answer",
      pendingBookingStepPromptAnchorSeq:
        typeof nextRealtimeState.pendingBookingStepPromptAnchorSeq === "number"
          ? nextRealtimeState.pendingBookingStepPromptAnchorSeq
          : null,
    },
  };
}