// src/lib/voice/realtime/toolFollowup/resolveSyntheticDirectBookingFollowup.ts

import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";
import { clean } from "../utils/clean";

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

function resolvePromptAnchorSeq(
  state: MutableRealtimeBookingState
): number | undefined {
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

function buildDirectBookingPromptInstructions(params: {
  currentLocale: VoiceLocale | string;
  prompt: string;
}): string {
  const locale = clean(params.currentLocale) || "en-US";
  const prompt = clean(params.prompt);

  if (!prompt) return "";

  return [
    `Current call locale: ${locale}.`,
    "Speak the configured booking message below to the caller now.",
    "Use the message as the source of truth.",
    "Do not verify, reinterpret, correct, or recalculate dates, times, services, prices, availability, or booking details.",
    "Do not say that you are checking availability.",
    "Do not call any tool.",
    "Do not add extra questions beyond the configured message.",
    "Configured booking message:",
    prompt,
  ].join(" ");
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

  const instructions = buildDirectBookingPromptInstructions({
    currentLocale: params.currentLocale,
    prompt: nextRequiredPrompt,
  });

  if (!instructions) {
    return null;
  }

  const source = `tool_followup:${toolName}:synthetic_direct`;

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

  /**
   * Important:
   * The assistant has not spoken this prompt yet.
   * Do not mark the system as waiting for the user here.
   * response.done should be the point where the turn opens for user input.
   */
  nextRealtimeState.bookingTurnStatus = "waiting_assistant_prompt";

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
      bookingTurnStatus: "waiting_assistant_prompt",
      pendingBookingStepPromptAnchorSeq:
        typeof nextRealtimeState.pendingBookingStepPromptAnchorSeq === "number"
          ? nextRealtimeState.pendingBookingStepPromptAnchorSeq
          : null,
    },
  };
}