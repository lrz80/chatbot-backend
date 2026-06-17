// src/lib/voice/realtime/buildExactRealtimeSpeechResponse.ts

export type ExactRealtimeSpeechLocale = "en-US" | "es-ES" | "pt-BR" | string;

export function buildExactRealtimeSpeechResponse(params: {
  prompt: string;
  currentLocale: ExactRealtimeSpeechLocale;
}): Record<string, unknown> {
  const prompt = String(params.prompt ?? "").trim();

  return {
    conversation: "none",
    tool_choice: "none",
    metadata: {
      purpose: "exact_booking_prompt",
      expected_prompt: prompt,
      locale: params.currentLocale,
    },
    instructions: [
      "You are a speech renderer for a live phone booking flow.",
      "Speak exactly the booking prompt provided in the input.",
      "Do not use conversation history.",
      "Do not reason.",
      "Do not explain.",
      "Do not acknowledge.",
      "Do not mention availability.",
      "Do not add any other words.",
      `The active language is ${params.currentLocale}.`,
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