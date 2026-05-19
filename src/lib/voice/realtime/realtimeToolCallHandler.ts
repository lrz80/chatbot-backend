//src/lib/voice/realtime/realtimeToolCallHandler.ts
import WebSocket from "ws";
import type { CallState } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";
import { type RealtimeToolResult } from "./buildToolFollowupInstructions";
import { validateSubmitBookingStepFreshness } from "./toolGuards/validateSubmitBookingStepFreshness";
import { guardRealtimeEndCall } from "./toolGuards/guardRealtimeEndCall";
import { guardSendBookingSms } from "./toolGuards/guardSendBookingSms";
import { buildNextRealtimeStateFromToolResult } from "./toolState/buildNextRealtimeStateFromToolResult";
import { buildEffectiveRealtimeToolArgs } from "./toolArgs/buildEffectiveRealtimeToolArgs";
import { resolveRealtimeToolFollowupInstructions } from "./toolFollowup/resolveRealtimeToolFollowupInstructions";
import { guardSubmitBookingStepFlowLoaded } from "./toolGuards/guardSubmitBookingStepFlowLoaded";
import { handleRealtimeToolError } from "./toolErrors/handleRealtimeToolError";
import { guardTenantReady } from "./toolGuards/guardTenantReady";
import { handleBlockedSubmitBookingStep } from "./toolGuards/handleBlockedSubmitBookingStep";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type HandleRealtimeToolCallParams = {
  event: any;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
  ) => void;
  callSid: string | null;
  tenantId: string | null;
  callerPhone: string | null;
  didNumber: string | null;
  realtimeTenant: any;
  realtimeCfg: any;
  realtimeState: CallState;
  currentLocale: VoiceLocale;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
  lastUserTranscript: string;
  lastUserDigits: string;
};

type HandleRealtimeToolCallResult = {
  consumed: boolean;
  result?: any;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  hangupRequestedByTool: boolean;
  callEnding: boolean;
  resetLastUserDigits: boolean;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export async function handleRealtimeToolCall(
  params: HandleRealtimeToolCallParams
): Promise<HandleRealtimeToolCallResult> {
  const {
    event,
    openAiSocket,
    requestRealtimeResponse,
    callSid,
    tenantId,
    callerPhone,
    didNumber,
    realtimeTenant,
    realtimeCfg,
    realtimeState,
    currentLocale,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
    lastUserDigits,
  } = params;

  if (event?.type !== "response.function_call_arguments.done") {
    return {
      consumed: false,
      realtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: false,
    };
  }

  const toolName = clean(event.name || "");
  const callId = clean(event.call_id || "");

  let toolArgs: Record<string, any> = {};

  if (callEnding && toolName !== "end_call") {
    const blockedResult: RealtimeToolResult = {
      ok: false,
      error: "CALL_ENDING",
    };

    sendJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(blockedResult),
      },
    });

    return {
      consumed: true,
      realtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: false,
    };
  }

  try {
    toolArgs = JSON.parse(String(event.arguments || "{}"));
  } catch {
    toolArgs = {};
  }

  if (toolName === "end_call") {
    const endCallGuard = guardRealtimeEndCall({
      callSid,
      realtimeState,
      lastUserTranscript,
    });

    if (!endCallGuard.ok) {
      const blockedResult: RealtimeToolResult = {
        ok: false,
        error: endCallGuard.error,
        message: endCallGuard.message,
      };

      console.warn(
        `[VOICE_REALTIME][${endCallGuard.logEvent}]`,
        endCallGuard.logPayload
      );

      sendJson(openAiSocket, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(blockedResult),
        },
      });

      requestRealtimeResponse(
        {
          instructions: endCallGuard.responseInstructions,
        },
        endCallGuard.responseSource
      );

      return {
        consumed: true,
        result: blockedResult,
        realtimeState,
        bookingFlowLoaded,
        hangupRequestedByTool: false,
        callEnding,
        resetLastUserDigits: endCallGuard.resetLastUserDigits,
      };
    }
  }

  console.log("[VOICE_REALTIME][TOOL_CALL]", {
    callSid,
    toolName,
    callId,
    toolArgs,
  });

  const tenantReadyGuard = guardTenantReady({
    tenantId,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  });

  if (tenantReadyGuard.handled) {
    return {
      consumed: true,
      realtimeState: tenantReadyGuard.realtimeState,
      bookingFlowLoaded: tenantReadyGuard.bookingFlowLoaded,
      hangupRequestedByTool: tenantReadyGuard.hangupRequestedByTool,
      callEnding: tenantReadyGuard.callEnding,
      resetLastUserDigits: tenantReadyGuard.resetLastUserDigits,
    };
  }

  if (!tenantId) {
    throw new Error("TENANT_NOT_READY_AFTER_GUARD");
  }

  const resolvedTenantId: string = tenantId;
  
  const sendBookingSmsGuard = await guardSendBookingSms({
    toolName,
    toolArgs,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    callSid,
    tenantId: resolvedTenantId,
    callerPhone,
    didNumber,
    realtimeTenant,
    realtimeCfg,
    realtimeState,
    currentLocale,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
    lastUserDigits,
  });

  if (sendBookingSmsGuard.handled) {
    return {
      consumed: true,
      result: sendBookingSmsGuard.result,
      realtimeState: sendBookingSmsGuard.realtimeState,
      bookingFlowLoaded: sendBookingSmsGuard.bookingFlowLoaded,
      hangupRequestedByTool: sendBookingSmsGuard.hangupRequestedByTool,
      callEnding: sendBookingSmsGuard.callEnding,
      resetLastUserDigits: sendBookingSmsGuard.resetLastUserDigits,
    };
  }

  const bookingFlowLoadedGuard = guardSubmitBookingStepFlowLoaded({
    toolName,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    callSid,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  });

  if (bookingFlowLoadedGuard.handled) {
    return {
      consumed: true,
      result: bookingFlowLoadedGuard.result,
      realtimeState: bookingFlowLoadedGuard.realtimeState,
      bookingFlowLoaded: bookingFlowLoadedGuard.bookingFlowLoaded,
      hangupRequestedByTool: bookingFlowLoadedGuard.hangupRequestedByTool,
      callEnding: bookingFlowLoadedGuard.callEnding,
      resetLastUserDigits: bookingFlowLoadedGuard.resetLastUserDigits,
    };
  }

  if (toolName === "submit_booking_step") {
    const freshness = validateSubmitBookingStepFreshness({
      toolArgs,
      realtimeState,
      lastUserTranscript,
    });

    if (!freshness.ok) {
      return handleBlockedSubmitBookingStep({
        callSid,
        callId,
        openAiSocket,
        requestRealtimeResponse,
        freshness,
        realtimeState,
        bookingFlowLoaded,
        callEnding,
      });
    }
  }

  const effectiveToolArgs = buildEffectiveRealtimeToolArgs({
    toolName,
    toolArgs,
    lastUserTranscript,
  });

  if (toolName === "submit_booking_step") {
    const modelValue = clean(toolArgs.value || "");
    const transcriptValue = clean(lastUserTranscript || "");

    effectiveToolArgs.model_value = modelValue;
    effectiveToolArgs.transcript_value = transcriptValue;

    /**
     * For submit_booking_step, prefer the structured value extracted by the
     * realtime model when it is present.
     *
     * lastUserTranscript can lag behind, include previous speech, or contain
     * noisy partial transcription. The model tool argument is the extracted
     * value for the current pending step.
     *
     * Validation inside executeRealtimeTool remains the source of truth:
     * if the extracted value does not satisfy the current step, it must reject it.
     */
    effectiveToolArgs.value = modelValue || transcriptValue;
    effectiveToolArgs.value_source = modelValue
      ? "model_extracted_value"
      : "fresh_user_transcript";
  }

  if (toolName === "submit_booking_step") {
    console.log("[VOICE_REALTIME][SUBMIT_STEP_VALUE_SOURCE]", {
      callSid,
      step_key: effectiveToolArgs.step_key,
      model_value: clean(toolArgs.value || ""),
      transcript_value: clean(lastUserTranscript || ""),
      final_value: clean(effectiveToolArgs.value || ""),
      value_source: effectiveToolArgs.value_source,
    });
  }

  try {
    const toolResult = await executeRealtimeTool({
      tenantId: resolvedTenantId,
      callerPhone,
      toolName,
      args: effectiveToolArgs,
      tenant: realtimeTenant,
      cfg: realtimeCfg,
      callSid: callSid || undefined,
      didNumber: didNumber || undefined,
      currentLocale,
      state: realtimeState,
      userInput: lastUserTranscript,
      digits: lastUserDigits,
    });

    const nextBookingFlowLoaded =
      toolName === "get_booking_flow" && toolResult?.ok ? true : bookingFlowLoaded;

    const nextRealtimeState = buildNextRealtimeStateFromToolResult({
      realtimeState,
      toolName,
      toolResult,
      effectiveToolArgs,
      currentLocale,
      lastUserTranscript,
    });

    const hangupRequestedByTool =
      toolName === "end_call" && toolResult?.ok === true;

    /**
     * Do not mark callEnding here.
     * The bridge still needs to send the goodbye audio generated after end_call.
     * callEnding must become true only after the goodbye response is done
     * and Twilio hangup is actually triggered.
     */
    const nextCallEnding = callEnding;

    console.log("[VOICE_REALTIME][TOOL_RESULT]", {
      callSid,
      toolName,
      ok: toolResult?.ok,
      error: toolResult?.error,
      missing_required_slots: toolResult?.missing_required_slots,
      next_required_step: toolResult?.next_required_step,
    });

    sendJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(toolResult),
      },
    });

    const followupInstructions = resolveRealtimeToolFollowupInstructions({
      toolName,
      toolResult: (toolResult || {}) as RealtimeToolResult,
    });

    requestRealtimeResponse(
      {
        instructions: followupInstructions,
      },
      `tool_followup:${toolName}`
    );

    return {
      consumed: true,
      result: toolResult as RealtimeToolResult,
      realtimeState: nextRealtimeState,
      bookingFlowLoaded: nextBookingFlowLoaded,
      hangupRequestedByTool,
      callEnding: nextCallEnding,
      resetLastUserDigits: true,
    };
  } catch (error) {
    return handleRealtimeToolError({
      error,
      callSid,
      toolName,
      callId,
      openAiSocket,
      requestRealtimeResponse,
      realtimeState,
      bookingFlowLoaded,
      callEnding,
    });
  }
}