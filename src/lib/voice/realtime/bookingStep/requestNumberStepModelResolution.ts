// src/lib/voice/realtime/bookingStep/requestNumberStepModelResolution.ts

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function requestNumberStepModelResolution(params: {
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
    return;
  }

  console.warn("[VOICE_REALTIME][NUMBER_STEP_MODEL_RESOLUTION_REQUESTED]", {
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
        "",
        "The caller answered the current booking step, and this step expects a numeric value.",
        `Current booking step key: ${pendingBookingStepKey}`,
        `Caller latest answer: ${lastUserTranscript}`,
        "",
        "Normalize the caller's latest answer into digits.",
        "Preserve the unit if the caller said one, for example pounds, libras, kg, kilos, minutes, people, guests, or similar.",
        "If the caller clearly provided a number in words, convert it to digits.",
        "",
        "If there is a clear numeric value, call submit_booking_step with:",
        `- step_key: ${pendingBookingStepKey}`,
        "- value: the normalized numeric value with digits",
        "",
        "If there is no clear numeric value, call submit_booking_step with:",
        `- step_key: ${pendingBookingStepKey}`,
        "- value: the caller's latest answer exactly as heard",
        "",
        "Never ask the current booking question yourself.",
        "Never call get_booking_flow.",
        "Never check availability.",
        "Do not make availability-related comments.",
        "Never say a time is available or unavailable.",
        "Never explain anything.",
        "Examples of valid normalized values: 20 libras, 30 pounds, 12 kg, 4 people.",
      ].join("\n"),
      tool_choice: "required",
    },
    "booking_step_number_model_resolution"
  );
}