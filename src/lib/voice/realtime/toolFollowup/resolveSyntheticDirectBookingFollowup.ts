// src/lib/voice/realtime/toolFollowup/resolveSyntheticDirectBookingFollowup.ts

import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";
import { clean } from "../utils/clean";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type BookingNextRequiredStep = {
  step_key?: unknown;
  prompt?: unknown;
  retry_prompt?: unknown;
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
  isRetry: boolean;
}): string {
  const locale = clean(params.currentLocale) || "en-US";
  const prompt = clean(params.prompt);

  if (!prompt) return "";

  return [
    `Current call locale: ${locale}.`,
    params.isRetry
      ? "The caller's previous answer was not valid or the requested option was not available."
      : "The caller's previous answer was accepted and the backend selected the next required booking step.",
    "",
    "Critical booking prompt rule:",
    "Say the text inside <booking_prompt> and </booking_prompt> as the booking question now.",
    "You may only make pronunciation natural for voice, but you must not add new booking facts.",
    "Do not add any confirmation, summary, explanation, or extra question before or after it.",
    "Do not say the appointment is booked, scheduled, reserved, confirmed, created, completed, set, or locked in.",
    "Do not say “agendamos”, “quedó agendado”, “reservado”, “confirmado”, “listo”, or any equivalent booking-completion phrase.",
    "Do not mention any date, time, service, staff member, price, policy, customer name, phone number, address, or appointment detail unless that exact information appears inside <booking_prompt>.",
    "Do not verify, reinterpret, correct, recalculate, or re-check dates, times, services, prices, availability, or booking details.",
    "Do not say that you are checking availability.",
    "Do not call any tool.",
    "Ask only this one booking question.",
    "After asking it, stop and wait for the caller answer.",
    "",
    "<booking_prompt>",
    prompt,
    "</booking_prompt>",
  ].join("\n");
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
  const retryPrompt = clean(nextRequiredStep?.retry_prompt || "");

  if (!nextRequiredStepKey) {
    return null;
  }

  const isRetry = params.toolResult?.ok === false;

  const promptToAsk = isRetry
    ? retryPrompt || nextRequiredPrompt
    : nextRequiredPrompt;

  if (!promptToAsk) {
    return null;
  }

  const instructions = buildDirectBookingPromptInstructions({
    currentLocale: params.currentLocale,
    prompt: promptToAsk,
    isRetry,
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
  nextRealtimeState.pendingBookingStepPrompt = promptToAsk;
  nextRealtimeState.pendingBookingStepRequired =
    typeof nextRequiredStep?.required === "boolean"
      ? nextRequiredStep.required
      : true;

  /**
   * The assistant has not spoken this prompt yet.
   * response.done opens the turn for user input.
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
      nextRequiredPrompt: promptToAsk,
      source,
      bookingTurnStatus: "waiting_assistant_prompt",
      pendingBookingStepPromptAnchorSeq:
        typeof nextRealtimeState.pendingBookingStepPromptAnchorSeq === "number"
          ? nextRealtimeState.pendingBookingStepPromptAnchorSeq
          : null,
    },
  };
}