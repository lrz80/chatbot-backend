// src/lib/voice/realtime/handleRealtimeUserTranscript.ts
import WebSocket from "ws";
import type { CallState } from "../types";
import { handleUserTranscriptCompleted } from "./realtimeTranscriptRuntime";
import { mergeTranscriptStatePreservingBookingRuntime } from "./bookingRuntimeState";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

export type HandleRealtimeUserTranscriptResult = {
  consumed: boolean;
  ignoredReason?:
    | "CALL_ENDING"
    | "EMPTY_TRANSCRIPT"
    | "TOO_CLOSE_TO_ASSISTANT_AUDIO"
    | "RUNTIME_NOT_CONSUMED";
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  realtimeTenant: any;
  realtimeCfg: any;
  localeLocked: boolean;
  tenantId: string | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function nowMs(): number {
  return Date.now();
}

/**
 * This guard is intentionally language-agnostic.
 *
 * Do not add Spanish/English/Portuguese phrases here.
 * This layer only decides whether the transcript is safe to accept as human input.
 * Meaning/intent/slot validation belongs to booking/service resolvers.
 */
function shouldIgnoreTranscriptBeforeRuntime(params: {
  callEnding: boolean;
  rawTranscript: string;
  assistantSpeaking: boolean;
  lastAssistantAudioDoneAtMs: number;
  minMsAfterAssistantAudio: number;
}): {
  ignore: boolean;
  reason?:
    | "CALL_ENDING"
    | "EMPTY_TRANSCRIPT"
    | "TOO_CLOSE_TO_ASSISTANT_AUDIO";
  msSinceAssistantAudioDone: number | null;
} {
  if (params.callEnding) {
    return {
      ignore: true,
      reason: "CALL_ENDING",
      msSinceAssistantAudioDone: null,
    };
  }

  if (!clean(params.rawTranscript)) {
    return {
      ignore: true,
      reason: "EMPTY_TRANSCRIPT",
      msSinceAssistantAudioDone: null,
    };
  }

  const lastAssistantAudioDoneAtMs = finiteNumber(
    params.lastAssistantAudioDoneAtMs,
    0
  );

  if (lastAssistantAudioDoneAtMs <= 0) {
    return {
      ignore: false,
      msSinceAssistantAudioDone: null,
    };
  }

  const msSinceAssistantAudioDone = nowMs() - lastAssistantAudioDoneAtMs;

  if (msSinceAssistantAudioDone < params.minMsAfterAssistantAudio) {
    return {
      ignore: true,
      reason: "TOO_CLOSE_TO_ASSISTANT_AUDIO",
      msSinceAssistantAudioDone,
    };
  }

  return {
    ignore: false,
    msSinceAssistantAudioDone,
  };
}

export async function handleRealtimeUserTranscript(params: {
  event: any;
  callSid: string | null;
  didNumber: string | null;
  model: string;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  realtimeTenant: any;
  realtimeCfg: any;
  localeLocked: boolean;
  lastUserTranscriptSeq: number;
  refreshRealtimeVoiceContext: any;
  refreshRealtimeSession: any;
  openAiSocket: WebSocket;
  tenantId: string | null;
  callEnding: boolean;

  /**
   * True while OpenAI is producing assistant audio.
   * This prevents assistant echo from being accepted as user input.
   */
  assistantSpeaking: boolean;

  /**
   * Timestamp from response.done or final audio event.
   * Used as a short grace window after Aamy finishes speaking.
   */
  lastAssistantAudioDoneAtMs: number;

  /**
   * Production default: 700–1200ms.
   * Keep configurable from bridge so tenants/calls can be tuned later.
   */
  minMsAfterAssistantAudio?: number;
}): Promise<HandleRealtimeUserTranscriptResult> {
  const rawTranscript = clean(params.event?.transcript);

  const minMsAfterAssistantAudio =
    typeof params.minMsAfterAssistantAudio === "number" &&
    Number.isFinite(params.minMsAfterAssistantAudio)
      ? params.minMsAfterAssistantAudio
      : 900;

  const preGuard = shouldIgnoreTranscriptBeforeRuntime({
    callEnding: params.callEnding,
    rawTranscript,
    assistantSpeaking: params.assistantSpeaking,
    lastAssistantAudioDoneAtMs: params.lastAssistantAudioDoneAtMs,
    minMsAfterAssistantAudio,
  });

  if (preGuard.ignore) {
    console.warn("[VOICE_REALTIME][USER_TRANSCRIPT_IGNORED]", {
      callSid: params.callSid,
      reason: preGuard.reason,
      transcript: rawTranscript,
      assistantSpeaking: params.assistantSpeaking,
      lastAssistantAudioDoneAtMs: params.lastAssistantAudioDoneAtMs || null,
      msSinceAssistantAudioDone: preGuard.msSinceAssistantAudioDone,
      minMsAfterAssistantAudio,
    });

    return {
      consumed: false,
      ignoredReason: preGuard.reason,
      lastUserTranscript: "",
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
      currentLocale: params.currentLocale,
      realtimeState: params.realtimeState,
      realtimeTenant: params.realtimeTenant,
      realtimeCfg: params.realtimeCfg,
      localeLocked: params.localeLocked,
      tenantId: params.tenantId,
    };
  }

  const runtimeResult = await handleUserTranscriptCompleted({
    event: params.event,
    callSid: params.callSid,
    didNumber: params.didNumber,
    model: params.model,
    currentLocale: params.currentLocale,
    realtimeState: params.realtimeState,
    realtimeTenant: params.realtimeTenant,
    realtimeCfg: params.realtimeCfg,
    localeLocked: params.localeLocked,
    lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    refreshRealtimeVoiceContext: params.refreshRealtimeVoiceContext,
    refreshRealtimeSession: params.refreshRealtimeSession,
    openAiSocket: params.openAiSocket,
    tenantId: params.tenantId,
  });

  if (!runtimeResult.consumed) {
    return {
      consumed: false,
      ignoredReason: "RUNTIME_NOT_CONSUMED",
      lastUserTranscript: "",
      lastUserTranscriptSeq: params.lastUserTranscriptSeq,
      currentLocale: params.currentLocale,
      realtimeState: params.realtimeState,
      realtimeTenant: params.realtimeTenant,
      realtimeCfg: params.realtimeCfg,
      localeLocked: params.localeLocked,
      tenantId: params.tenantId,
    };
  }

  const latestToolState = params.realtimeState;

  const nextRealtimeState = mergeTranscriptStatePreservingBookingRuntime({
    currentToolState: latestToolState,
    transcriptState: runtimeResult.realtimeState,
    lastUserTranscriptSeq: runtimeResult.lastUserTranscriptSeq,
  });

  console.log("[VOICE_REALTIME][USER_TRANSCRIPT_ACCEPTED]", {
    callSid: params.callSid,
    transcript: runtimeResult.lastUserTranscript,
    lastUserTranscriptSeq: runtimeResult.lastUserTranscriptSeq,
    currentLocale: runtimeResult.currentLocale,
    bookingTurnStatus: (nextRealtimeState as any).bookingTurnStatus || "",
    pendingBookingStepKey: nextRealtimeState.pendingBookingStepKey || "",
    pendingBookingStepPromptAnchorSeq:
      typeof nextRealtimeState.pendingBookingStepPromptAnchorSeq === "number"
        ? nextRealtimeState.pendingBookingStepPromptAnchorSeq
        : null,
  });

  return {
    consumed: true,
    lastUserTranscript: runtimeResult.lastUserTranscript,
    lastUserTranscriptSeq: runtimeResult.lastUserTranscriptSeq,
    currentLocale: runtimeResult.currentLocale,
    realtimeState: nextRealtimeState,
    realtimeTenant: runtimeResult.realtimeTenant,
    realtimeCfg: runtimeResult.realtimeCfg,
    localeLocked: runtimeResult.localeLocked,
    tenantId: runtimeResult.tenantId,
  };
}