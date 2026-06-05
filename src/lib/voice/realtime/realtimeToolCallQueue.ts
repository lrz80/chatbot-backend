// src/lib/voice/realtime/realtimeToolCallQueue.ts
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

function isProtocolValueForStep(params: {
  stepKey: string;
  value: string;
}): boolean {
  const stepKey = normalizeKey(params.stepKey);
  const value = normalizeKey(params.value);

  if (stepKey === "confirm" || stepKey === "confirmation") {
    return value === "confirm" || value === "cancel" || value === "unknown";
  }

  return false;
}

function buildSyntheticSubmitBookingStepEvent(params: {
  callId: string;
  stepKey: string;
  value: string;
  source: string;
  sourceTranscript?: string;
  sourceTranscriptSeq?: number;
  resolvedBy?: string;
}): any {
  const args: Record<string, unknown> = {
    step_key: params.stepKey,
    value: params.value,
    resolved_candidate_source: params.resolvedBy || "backend",
  };

  if (params.sourceTranscript) {
    args.source_transcript = params.sourceTranscript;
  }

  if (typeof params.sourceTranscriptSeq === "number") {
    args.source_transcript_seq = params.sourceTranscriptSeq;
  }

  if (params.resolvedBy) {
    args.resolved_by = params.resolvedBy;
  }

  return {
    type: "response.function_call_arguments.done",
    name: "submit_booking_step",
    call_id: params.callId,
    arguments: JSON.stringify(args),

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

    toolName: "create_appointment",
    callId: params.callId,
    toolArgs: args,

    synthetic: true,
    syntheticSource: params.source,
  };
}

function buildPendingStepModelResolutionResponse(params: {
  stepKey: string;
  transcript: string;
  transcriptSeq: number;
}): Record<string, unknown> {
  return {
    instructions: [
      "You are resolving the user's latest answer for a pending booking step.",
      "Do not speak to the user.",
      "Do not explain.",
      "Call submit_booking_step exactly once.",
      "",
      "Use the exact step_key provided below.",
      "Return only a structured value appropriate for that step.",
      "",
      "If the pending step is a confirmation step, value must be exactly one of:",
      '- "confirm"',
      '- "cancel"',
      '- "unknown"',
      "",
      'Use "confirm" only when the user clearly confirms.',
      'Use "cancel" only when the user clearly rejects, cancels, or says the booking is not correct.',
      'Use "unknown" when the answer is unclear, unrelated, incomplete, or ambiguous.',
      "",
      "You must include these metadata fields in the submit_booking_step arguments:",
      '- resolved_by: "backend_model_resolution"',
      "- source_transcript_seq: the exact number provided below",
      "- source_transcript: the exact user answer provided below",
      "",
      `step_key: ${JSON.stringify(params.stepKey)}`,
      `source_transcript_seq: ${params.transcriptSeq}`,
      `source_transcript: ${JSON.stringify(params.transcript)}`,
      "",
      "submit_booking_step arguments shape:",
      JSON.stringify({
        step_key: params.stepKey,
        value: "resolved value",
        resolved_by: "backend_model_resolution",
        resolved_candidate_source: "model",
        source_transcript_seq: params.transcriptSeq,
        source_transcript: params.transcript,
      }),
    ].join("\n"),
  };
}

function shouldResolvePendingStepWithModel(params: {
  stepKey: string;
  value: string;
}): boolean {
  const stepKey = normalizeKey(params.stepKey);

  if (isProtocolValueForStep(params)) {
    return false;
  }

  return stepKey === "confirm" || stepKey === "confirmation";
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
    const transcriptSeq = params.getLastUserTranscriptSeq();

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

    if (
      shouldResolvePendingStepWithModel({
        stepKey,
        value,
      })
    ) {
      console.warn("[VOICE_REALTIME][PENDING_STEP_MODEL_RESOLUTION_REQUESTED]", {
        callSid: params.getCallSid(),
        stepKey,
        transcriptSeq,
        source: paramsForSubmit.source,
      });

      params.requestRealtimeResponse(
        buildPendingStepModelResolutionResponse({
          stepKey,
          transcript: value,
          transcriptSeq,
        }),
        "booking_step_model_resolution"
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
      lastUserTranscriptSeq: transcriptSeq,
      source: paramsForSubmit.source,
    });

    enqueueRealtimeToolCall(
      buildSyntheticSubmitBookingStepEvent({
        callId,
        stepKey,
        value,
        source: paramsForSubmit.source,
        sourceTranscript: value,
        sourceTranscriptSeq: transcriptSeq,
        resolvedBy: "backend_direct",
      })
    );
  }

  return {
    enqueueRealtimeToolCall,
    enqueueSubmitBookingStepFromTranscript,
  };
}