//src/lib/voice/realtime/realtimeToolCallQueue.ts
import WebSocket from "ws";
import type { CallState } from "../types";
import { handleRealtimeToolCall } from "./realtimeToolCallHandler";
import { attachLatestUserTranscriptSeq } from "./bookingRuntimeState";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

type RealtimeToolCallQueueParams = {
  openAiSocket: WebSocket;
  requestRealtimeResponse: RequestRealtimeResponse;

  getCallSid: () => string | null;
  getTenantId: () => string | null;
  getCallerPhone: () => string | null;
  getDidNumber: () => string | null;
  getRealtimeTenant: () => any;
  getRealtimeCfg: () => any;
  getRealtimeState: () => CallState;
  getCurrentLocale: () => VoiceLocale;
  getBookingFlowLoaded: () => boolean;
  getCallEnding: () => boolean;
  getLastUserTranscript: () => string;
  getLastUserTranscriptSeq: () => number;
  getLastUserDigits: () => string;

  setRealtimeState: (state: CallState) => void;
  setBookingFlowLoaded: (value: boolean) => void;
  setHangupRequestedByTool: (value: boolean) => void;
  setCallEnding: (value: boolean) => void;
  resetLastUserDigits: () => void;
};

export function createRealtimeToolCallQueue(
  params: RealtimeToolCallQueueParams
) {
  let realtimeToolQueue: Promise<void> = Promise.resolve();

  function enqueueRealtimeToolCall(event: any): void {
    realtimeToolQueue = realtimeToolQueue
      .then(async () => {
        const currentRealtimeState = params.getRealtimeState();
        const lastUserTranscriptSeq = params.getLastUserTranscriptSeq();

        const toolCallResult = await handleRealtimeToolCall({
          event,
          openAiSocket: params.openAiSocket,
          requestRealtimeResponse: params.requestRealtimeResponse,
          callSid: params.getCallSid(),
          tenantId: params.getTenantId(),
          callerPhone: params.getCallerPhone(),
          didNumber: params.getDidNumber(),
          realtimeTenant: params.getRealtimeTenant(),
          realtimeCfg: params.getRealtimeCfg(),
          realtimeState: currentRealtimeState,
          currentLocale: params.getCurrentLocale(),
          bookingFlowLoaded: params.getBookingFlowLoaded(),
          callEnding: params.getCallEnding(),
          lastUserTranscript: params.getLastUserTranscript(),
          lastUserDigits: params.getLastUserDigits(),
        });

        if (!toolCallResult.consumed) {
          return;
        }

        params.setRealtimeState(
          attachLatestUserTranscriptSeq({
            realtimeState: toolCallResult.realtimeState,
            lastUserTranscriptSeq,
          })
        );

        params.setBookingFlowLoaded(toolCallResult.bookingFlowLoaded);

        if (toolCallResult.hangupRequestedByTool) {
          params.setHangupRequestedByTool(true);
        }

        params.setCallEnding(toolCallResult.callEnding);

        if (toolCallResult.resetLastUserDigits) {
          params.resetLastUserDigits();
        }
      })
      .catch((error) => {
        console.error("[VOICE_REALTIME][TOOL_HANDLER_FATAL_ERROR]", {
          callSid: params.getCallSid(),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  return {
    enqueueRealtimeToolCall,
  };
}