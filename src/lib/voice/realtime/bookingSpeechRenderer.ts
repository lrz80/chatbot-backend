// src/lib/voice/realtime/bookingSpeechRenderer.ts

export type VoiceLocale = string;

export type BookingSpeechMode = "exact" | "natural";

type BuildBookingSpeechResponseParams = {
  stepKey: string;
  prompt: string;
  currentLocale: VoiceLocale;
  mode?: BookingSpeechMode;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function shouldUseExactBookingPrompt(stepKey: string): boolean {
  const normalized = clean(stepKey).toLowerCase();

  return (
    normalized === "phone" ||
    normalized === "confirm" ||
    normalized === "offer_booking_sms"
  );
}

export function buildBookingSpeechResponse(
  params: BuildBookingSpeechResponseParams
): Record<string, unknown> {
  const prompt = clean(params.prompt);
  const stepKey = clean(params.stepKey);
  const mode =
    params.mode || (shouldUseExactBookingPrompt(stepKey) ? "exact" : "natural");

  if (mode === "exact") {
    return {
      conversation: "none",
      tool_choice: "none",
      metadata: {
        purpose: "booking_step_speech",
        mode: "exact",
        step_key: stepKey,
      },
      instructions: [
        "You are a speech renderer for a live phone booking flow.",
        "Speak exactly the booking prompt provided in the input.",
        "Do not use conversation history.",
        "Do not reason.",
        "Do not mention availability.",
        "Do not add any other words.",
      ].join("\n"),
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Speak exactly this booking prompt and nothing else:",
                "",
                prompt,
              ].join("\n"),
            },
          ],
        },
      ],
    };
  }

  return {
    conversation: "none",
    tool_choice: "none",
    metadata: {
      purpose: "booking_step_speech",
      mode: "natural",
      step_key: stepKey,
      locale: params.currentLocale,
    },
    instructions: [
      "You are a speech renderer for a live phone booking flow.",
      "Your only job is to ask the next required booking question naturally.",
      "Use the caller's active language.",
      "Support any language the caller is using.",
      "Ask exactly one question.",
      "Keep it short.",
      "Do not call tools.",
      "Do not use conversation history.",
      "Do not mention checking availability.",
      "Do not say you are verifying anything.",
      "Do not say one moment.",
      "Do not invent services, prices, staff, dates, times, policies, locations, or availability.",
      "Do not answer business questions.",
      "Do not add another step.",
      "Do not change the required booking field.",
      "You may lightly rephrase the wording to sound human, but the meaning must stay the same.",
      "",
      `Required booking step key: ${stepKey}`,
      `Required booking question: ${prompt}`,
    ].join("\n"),
  };
}