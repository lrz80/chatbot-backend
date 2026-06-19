// src/lib/voice/realtime/bookingStep/requestServiceStepModelResolution.ts

type RequestRealtimeResponse = (
  payload: {
    instructions: string;
    tool_choice?: "auto" | "none" | "required";
  },
  source: string,
  options?: {
    sendToolOutputToOpenAi?: boolean;
  }
) => void;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function requestServiceStepModelResolution(params: {
  callSid: string | null;
  source: string;
  pendingBookingStepKey: string;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  pendingBookingStepPromptAnchorSeq: number;
  requestRealtimeResponse: RequestRealtimeResponse;
}): void {
  const pendingBookingStepKey = clean(params.pendingBookingStepKey);
  const lastUserTranscript = clean(params.lastUserTranscript);

  if (!pendingBookingStepKey || !lastUserTranscript) {
    console.warn("[VOICE_REALTIME][SERVICE_STEP_MODEL_RESOLUTION_SKIPPED]", {
      callSid: params.callSid,
      reason: "MISSING_STEP_OR_TRANSCRIPT",
      source: params.source,
      pendingBookingStepKey,
      lastUserTranscript,
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
      pendingBookingStepPromptAnchorSeq: params.pendingBookingStepPromptAnchorSeq,
    });

    return;
  }

  console.warn("[VOICE_REALTIME][SERVICE_STEP_MODEL_RESOLUTION_REQUESTED]", {
    callSid: params.callSid,
    source: params.source,
    pendingBookingStepKey,
    lastUserTranscript,
    lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    pendingBookingStepPromptAnchorSeq: params.pendingBookingStepPromptAnchorSeq,
  });

  params.requestRealtimeResponse(
    {
      instructions: [
        "Internal tool-routing task. Do not speak to the caller.",
        "Do not produce audio.",
        "Do not answer conversationally.",
        "Do not ask a question.",
        "Do not say anything to the caller.",
        "Do not explain anything.",
        "Do not make availability-related comments.",
        "Never say you are reviewing availability.",
        "Never say a time is available or unavailable.",
        "Never call get_booking_flow.",
        "Never call end_call.",
        "",
        "Use only the active booking flow and the latest caller transcript as source of truth.",
        "The current pending booking step is service.",
        `Current booking step key: ${pendingBookingStepKey}`,
        `Latest caller transcript: ${lastUserTranscript}`,
        "",
        "Use the current next_required_step.validation_config.options and speech_hints to resolve the caller's intended service.",
        "Do not submit the raw transcript as the service value unless it clearly matches one configured service option.",
        "",
        "If exactly one configured service is clearly intended, call submit_booking_step with:",
        `- step_key: ${pendingBookingStepKey}`,
        "- value: the configured/canonical service name",
        "",
        "If the service is not clear enough, still call submit_booking_step with:",
        `- step_key: ${pendingBookingStepKey}`,
        "- value: the caller's latest transcript exactly as heard",
        "",
        "Let the backend reject unclear service values and return the configured retry prompt.",
        "Always call submit_booking_step exactly once.",
        "Do not advance to another booking step yourself.",
      ].join("\n"),
      tool_choice: "required",
    },
    "booking_step_service_model_resolution",
    {
      sendToolOutputToOpenAi: false,
    }
  );
}