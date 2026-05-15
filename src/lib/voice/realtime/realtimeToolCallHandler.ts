//src/lib/voice/realtime/realtimeToolCallHandler.ts
import WebSocket from "ws";
import type { CallState } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";
import {
  buildToolFollowupInstructions,
  type RealtimeToolResult,
} from "./buildToolFollowupInstructions";

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

function shouldBlockEndCallForPendingStep(_state: CallState): boolean {
  return false;
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

  if (toolName === "end_call" && shouldBlockEndCallForPendingStep(realtimeState)) {
    console.warn("[VOICE_REALTIME][END_CALL_PENDING_STEP_BYPASSED]", {
      callSid,
      pendingBookingStepKey: clean(
        (realtimeState as any)?.pendingBookingStepKey || ""
      ),
      lastUserTranscript: clean(lastUserTranscript || ""),
    });
  }

  console.log("[VOICE_REALTIME][TOOL_CALL]", {
    callSid,
    toolName,
    callId,
    toolArgs,
  });

  if (!tenantId) {
    sendJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          ok: false,
          error: "TENANT_NOT_READY",
        }),
      },
    });

    requestRealtimeResponse({
      instructions:
        "Tell the caller briefly that the system is not ready to complete that action yet.",
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

  if (toolName === "submit_booking_step" && !bookingFlowLoaded) {
    const blockedResult: RealtimeToolResult = {
      ok: false,
      error: "BOOKING_FLOW_NOT_LOADED",
    };

    console.log("[VOICE_REALTIME][TOOL_RESULT]", {
      callSid,
      toolName,
      ok: false,
      error: blockedResult.error,
    });

    sendJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(blockedResult),
      },
    });

    requestRealtimeResponse({
      instructions: [
        "Call get_booking_flow now.",
        "Do not ask for any booking data yet.",
        "Do not call submit_booking_step again until get_booking_flow returns.",
        "After get_booking_flow returns, ask the next required booking question.",
        "Do not invent the current booking step."
      ].join(" "),
    });

    return {
      consumed: true,
      realtimeState: {
        ...realtimeState,
        bookingStepIndex: undefined,
        pendingBookingStepKey: undefined,
      } as CallState,
      bookingFlowLoaded: false,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: true,
    };
  }

  const effectiveToolArgs =
    toolName === "submit_booking_step"
      ? {
          ...toolArgs,
          step_key: clean(toolArgs.step_key || ""),
          value: clean(toolArgs.value || lastUserTranscript || ""),
          raw_transcript_value: clean(lastUserTranscript || ""),
        }
      : {
          ...toolArgs,
        };

  if (toolName === "submit_booking_step") {
    console.log("[VOICE_REALTIME][SUBMIT_STEP_VALUE_SOURCE]", {
      callSid,
      step_key: effectiveToolArgs.step_key,
      model_value: clean(toolArgs.value || ""),
      transcript_value: clean(lastUserTranscript || ""),
      final_value: clean(effectiveToolArgs.value || ""),
    });
  }

  try {
    const toolResult = await executeRealtimeTool({
      tenantId,
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

    const bookingState =
      toolResult &&
      typeof toolResult.booking_state === "object" &&
      toolResult.booking_state !== null
        ? (toolResult.booking_state as Record<string, unknown>)
        : null;

    const collectedSlots =
      bookingState &&
      bookingState.collected_slots &&
      typeof bookingState.collected_slots === "object"
        ? Object.fromEntries(
            Object.entries(bookingState.collected_slots as Record<string, unknown>)
              .map(([key, value]) => [clean(key), clean(value)])
              .filter(([key, value]) => key && value)
          )
        : {};

    const nextRequiredStep =
      toolResult &&
      typeof toolResult.next_required_step === "object" &&
      toolResult.next_required_step !== null
        ? (toolResult.next_required_step as Record<string, unknown>)
        : null;

    const resolvedPendingBookingStepKey =
      clean(nextRequiredStep?.step_key || "") || undefined;

    const shouldClearPendingBookingStep =
      toolName === "send_booking_sms" || toolName === "end_call";

    const nextRealtimeState: CallState = {
      ...realtimeState,
      lang: currentLocale,
      bookingData: {
        ...(realtimeState.bookingData || {}),
        ...collectedSlots,
      },
      pendingBookingStepKey: shouldClearPendingBookingStep
        ? undefined
        : resolvedPendingBookingStepKey,
      pendingBookingStepRequired: shouldClearPendingBookingStep
        ? undefined
        : (nextRequiredStep?.required === true ? true : undefined),
      pendingBookingStepPrompt: shouldClearPendingBookingStep
        ? undefined
        : clean(nextRequiredStep?.prompt || "") || undefined,
    } as CallState;

    const hangupRequestedByTool =
      toolName === "end_call" && toolResult?.ok === true;

    const nextCallEnding = callEnding || hangupRequestedByTool;

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

    requestRealtimeResponse(
      {
        instructions: buildToolFollowupInstructions({
          toolName,
          toolResult: (toolResult || {}) as RealtimeToolResult,
        }),
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
    console.error("[VOICE_REALTIME][TOOL_ERROR]", {
      callSid,
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });

    const toolErrorResult: RealtimeToolResult = {
      ok: false,
      error: error instanceof Error ? error.message : "TOOL_ERROR",
    };

    sendJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(toolErrorResult),
      },
    });

    requestRealtimeResponse(
      {
        instructions: buildToolFollowupInstructions({
          toolName,
          toolResult: toolErrorResult,
        }),
      },
      `tool_error:${toolName}`
    );

    return {
      consumed: true,
      realtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: false,
    };
  }
}