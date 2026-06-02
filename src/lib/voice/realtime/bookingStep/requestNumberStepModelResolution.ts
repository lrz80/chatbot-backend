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
        "The caller answered the current booking step, and this step expects a numeric value.",
        `Current booking step key: ${pendingBookingStepKey}`,
        `Caller latest answer: ${lastUserTranscript}`,
        "",
        "Normalize the caller's latest answer into digits, in the caller's active language.",
        "Preserve the unit if the caller said one, for example pounds, libras, kg, kilos, minutes, people, guests, or similar.",
        "If the caller clearly provided a number in words, convert it to digits.",
        "If the caller did not clearly provide a numeric value, ask the current booking question again naturally.",
        "Do not guess.",
        "Do not invent a number.",
        "Do not use earlier conversation context as the number.",
        "If there is a clear numeric value, call submit_booking_step with:",
        `- step_key: ${pendingBookingStepKey}`,
        "- value: the normalized numeric value with digits",
        "Examples of valid normalized values: 20 libras, 30 pounds, 12 kg, 4 people.",
      ].join("\n"),
    },
    "booking_step_number_model_resolution"
  );
}