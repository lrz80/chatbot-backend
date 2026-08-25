//src/lib/ai/models.ts
// src/lib/ai/models.ts

export const AI_MODELS = {
  realtime:
    process.env.OPENAI_REALTIME_MODEL ||
    "gpt-realtime",

  realtimeTranscription:
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ||
    "gpt-live-transcribe",

  fast:
    process.env.OPENAI_MODEL_FAST ||
    "gpt-4.1-mini",

  standard:
    process.env.OPENAI_MODEL_STANDARD ||
    "gpt-4o-mini",

  advanced:
    process.env.OPENAI_MODEL_ADVANCED ||
    "gpt-4o-mini",
} as const;