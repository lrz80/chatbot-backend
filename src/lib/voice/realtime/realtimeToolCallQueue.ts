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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return clean(value).toLowerCase();
}

function isConfirmationStepKey(value: unknown): boolean {
  const stepKey = normalizeKey(value);

  return stepKey === "confirm" || stepKey === "confirmation";
}

function isConfirmationProtocolValue(value: unknown): boolean {
  const normalized = normalizeKey(value);

  return (
    normalized === "confirm" ||
    normalized === "cancel" ||
    normalized === "unknown"
  );
}

function buildConfirmationModelResolutionResponse(params: {
  stepKey: string;
  transcript: string;
}): Record<string, unknown> {
  return {
    instructions: [
      "Resolve the user's latest answer for the pending booking confirmation step.",
      "Do not answer the user directly.",
      "Call submit_booking_step exactly once.",
      `Use step_key "${params.stepKey}".`,
      'For value, use only one of these protocol values: "confirm", "cancel", or "unknown".',
      'Use "confirm" only if the user clearly confirms the appointment.',
      'Use "cancel" only if the user clearly rejects or cancels the appointment.',
      'Use "unknown" if the user answer is unclear, incomplete, unrelated, or ambiguous.',
      `User answer: ${JSON.stringify(params.transcript)}`,
    ].join("\n"),
  };
}

function buildSyntheticSubmitBookingStepEvent(params: {
  callId: string;
  stepKey: string;
  value: string;
  source: string;
}): any {
  const args = {
    step_key: params.stepKey,
    value: params.value,
  };

  return {
    type: "response.function_call_arguments.done",
    name: "submit_booking_step",
    call_id: params.callId,
    arguments: JSON.stringify(args),

    // Campos redundantes a propósito para ser compatible con parsers internos
    // que puedan leer toolName/callId/toolArgs en vez de name/call_id/arguments.
    toolName: "submit_booking_step",
    callId: params.callId,
    toolArgs: args,

    synthetic: true,
    syntheticSource: params.source,
  };
}

function buildSyntheticCreateAppointmentEvent(params: {
  callId: string;
  source: string;
}): any {
  const args = {};

  return {
    type: "response.function_call_arguments.done",
    name: "create_appointment",
    call_id: params.callId,
    arguments: JSON.stringify(args),

    // Campos redundantes a propósito para ser compatible con parsers internos
    // que puedan leer toolName/callId/toolArgs en vez de name/call_id/arguments.
    toolName: "create_appointment",
    callId: params.callId,
    toolArgs: args,

    synthetic: true,
    syntheticSource: params.source,
  };
}

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

  function enqueueSubmitBookingStepFromTranscript(paramsForSubmit: {
    stepKey: string;
    value: string;
    source: string;
  }): void {
    const stepKey = clean(paramsForSubmit.stepKey);
    const value = clean(paramsForSubmit.value);

    if (!stepKey || !value) {
      console.warn("[VOICE_REALTIME][SYNTHETIC_SUBMIT_BOOKING_STEP_SKIPPED]", {
        callSid: params.getCallSid(),
        reason: "EMPTY_STEP_OR_VALUE",
        stepKey,
        value,
        source: paramsForSubmit.source,
      });

      return;
    }

    if (isConfirmationStepKey(stepKey) && !isConfirmationProtocolValue(value)) {
      console.warn("[VOICE_REALTIME][SYNTHETIC_CONFIRMATION_SUBMIT_REDIRECTED_TO_MODEL_RESOLUTION]", {
        callSid: params.getCallSid(),
        stepKey,
        value,
        lastUserTranscriptSeq: params.getLastUserTranscriptSeq(),
        source: paramsForSubmit.source,
      });

      params.requestRealtimeResponse(
        buildConfirmationModelResolutionResponse({
          stepKey,
          transcript: value,
        }),
        "booking_step_confirmation_model_resolution"
      );

      return;
    }

    const callId = `syn_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    console.warn("[VOICE_REALTIME][SYNTHETIC_SUBMIT_BOOKING_STEP_ENQUEUED]", {
      callSid: params.getCallSid(),
      stepKey,
      value,
      lastUserTranscriptSeq: params.getLastUserTranscriptSeq(),
      source: paramsForSubmit.source,
    });

    enqueueRealtimeToolCall(
      buildSyntheticSubmitBookingStepEvent({
        callId,
        stepKey,
        value,
        source: paramsForSubmit.source,
      })
    );
  }

  return {
    enqueueRealtimeToolCall,
    enqueueSubmitBookingStepFromTranscript,
  };
}