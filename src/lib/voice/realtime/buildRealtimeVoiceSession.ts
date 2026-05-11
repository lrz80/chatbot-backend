//src/lib/voice/realtime/buildRealtimeVoiceSession.ts
export type RealtimeVoiceSessionConfig = {
  model: string;
  voice: string;
  instructions: string;
};

export function buildRealtimeVoiceSession(): RealtimeVoiceSessionConfig {
  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2";
  const voice = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";

  return {
    model,
    voice,
    instructions: [
      "You are Aamy, a live phone assistant.",
      "Speak naturally, warmly, and briefly.",
      "Do not sound like an IVR or a recording.",
      "Ask only one question at a time.",
      "If you do not understand the caller, ask a short clarification question.",
      "Never invent business information.",
      "For now, this realtime runtime is in audio connectivity test mode.",
    ].join("\n"),
  };
}