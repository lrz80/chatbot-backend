// src/lib/voice/realtime/realtimeTranscriptRuntime.ts
import WebSocket from "ws";
import type { CallState, VoiceLocale } from "../types";
import { handleRealtimeTranscriptEvent } from "./realtimeTranscriptHandler";
import {
  mergeTranscriptStatePreservingBookingRuntime,
} from "./bookingRuntimeState";

export type RealtimeTranscriptRuntimeResult = {
  consumed: boolean;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  realtimeTenant: any;
  realtimeCfg: any;
  localeLocked: boolean;
  tenantId: string | null;
};

export async function handleUserTranscriptCompleted(params: {
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
}): Promise<RealtimeTranscriptRuntimeResult> {
  const transcriptResult = await handleRealtimeTranscriptEvent({
    event: params.event,
    callSid: params.callSid,
    didNumber: params.didNumber,
    model: params.model,
    currentLocale: params.currentLocale,
    realtimeState: params.realtimeState,
    realtimeTenant: params.realtimeTenant,
    realtimeCfg: params.realtimeCfg,
    localeLocked: params.localeLocked,
    refreshRealtimeVoiceContext: params.refreshRealtimeVoiceContext,
    refreshRealtimeSession: params.refreshRealtimeSession,
    openAiSocket: params.openAiSocket,
  });

  if (!transcriptResult.consumed) {
    return {
      consumed: false,
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

  const nextLastUserTranscriptSeq = params.lastUserTranscriptSeq + 1;

  const currentToolState = params.realtimeState;
  const transcriptState = transcriptResult.realtimeState;

  const nextRealtimeState = mergeTranscriptStatePreservingBookingRuntime({
    currentToolState,
    transcriptState,
    lastUserTranscriptSeq: nextLastUserTranscriptSeq,
  });

  return {
    consumed: true,
    lastUserTranscript: transcriptResult.transcript,
    lastUserTranscriptSeq: nextLastUserTranscriptSeq,
    currentLocale: transcriptResult.currentLocale,
    realtimeState: nextRealtimeState,
    realtimeTenant: transcriptResult.realtimeTenant ?? params.realtimeTenant,
    realtimeCfg: transcriptResult.realtimeCfg ?? params.realtimeCfg,
    localeLocked: transcriptResult.localeLocked,
    tenantId:
      typeof transcriptResult.tenantId !== "undefined"
        ? transcriptResult.tenantId ?? params.tenantId
        : params.tenantId,
  };
}