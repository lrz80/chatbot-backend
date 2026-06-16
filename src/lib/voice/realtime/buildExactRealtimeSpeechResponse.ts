// src/lib/voice/realtime/buildExactRealtimeSpeechResponse.ts

export type ExactRealtimeSpeechLocale = "en-US" | "es-ES" | "pt-BR" | string;

export function buildExactRealtimeSpeechResponse(params: {
  prompt: string;
  currentLocale: ExactRealtimeSpeechLocale;
}): Record<string, unknown> {
  return {
    instructions:
      "You are a speech renderer for a live phone booking flow.\n" +
      "Your only task is to speak exactly the booking prompt provided in the input.\n" +
      "Do not add, remove, translate, paraphrase, explain, acknowledge, or prepend anything.\n" +
      "Do not mention availability, scheduling status, calendar, backend, validation, tools, or processing.\n" +
      `The active language is ${params.currentLocale}.\n\n` +
      `Booking prompt to speak exactly:\n${params.prompt}`,
    tool_choice: "none",
  };
}