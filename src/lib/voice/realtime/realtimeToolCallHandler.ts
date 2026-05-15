//src/lib/voice/realtime/realtimeToolCallHandler.ts
import WebSocket from "ws";
import type { CallState } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";
import {
  buildToolFollowupInstructions,
  type RealtimeToolResult,
} from "./buildToolFollowupInstructions";
import { handlePendingBookingStepToolRedirect } from "./handlePendingBookingStepToolRedirect";

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

function buildBlockedBookingStepResult(error: string): RealtimeToolResult {
  return {
    ok: false,
    error,
    message: error,
  };
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

  if (toolName === "end_call") {
    const awaitingPostBookingClosure =
      (realtimeState as any)?.awaitingPostBookingClosure === true;

    const postBookingClosureTranscript = clean(
      (realtimeState as any)?.postBookingClosureTranscript || ""
    );

    const currentTranscript = clean(lastUserTranscript || "");

    const isImmediatePostSmsHangup =
      awaitingPostBookingClosure &&
      postBookingClosureTranscript &&
      postBookingClosureTranscript === currentTranscript;

    if (isImmediatePostSmsHangup) {
      const blockedResult: RealtimeToolResult = {
        ok: false,
        error: "POST_BOOKING_CLOSURE_ANSWER_REQUIRED",
        message:
          "The caller has not answered whether they need anything else after the booking SMS.",
      };

      console.warn("[VOICE_REALTIME][END_CALL_BLOCKED_WAITING_POST_SMS_REPLY]", {
        callSid,
        postBookingClosureTranscript,
        currentTranscript,
      });

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
          instructions: [
            "Use only the tool result as source of truth.",
            "Do not end the call yet.",
            "The booking SMS was sent, but the caller has not answered whether they need anything else.",
            "Ask briefly if the caller needs anything else.",
            "Ask only one question and wait for the caller answer.",
          ].join(" "),
        },
        "tool_guard:end_call_waiting_post_sms_reply"
      );

      return {
        consumed: true,
        result: blockedResult,
        realtimeState,
        bookingFlowLoaded,
        hangupRequestedByTool: false,
        callEnding,
        resetLastUserDigits: true,
      };
    }
  }

  if (toolName === "end_call" && shouldBlockEndCallForPendingStep(realtimeState)) {
    console.warn("[VOICE_REALTIME][END_CALL_PENDING_STEP_BYPASSED]", {
      callSid,
      pendingBookingStepKey: clean(
        realtimeState.pendingBookingStepKey || ""
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

  if (toolName === "send_booking_sms") {
    const pendingActionGranted =
      realtimeState.pendingActionGranted === true;

    const pendingActionToolName = clean(
      realtimeState.pendingActionToolName || ""
    );

    const canExecutePendingAction =
      pendingActionGranted && pendingActionToolName === toolName;

    if (!canExecutePendingAction) {
      const redirectResult = await handlePendingBookingStepToolRedirect({
        originalToolName: toolName,
        originalToolArgs: toolArgs,
        callId,
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
      });

      if (redirectResult.handled) {
        return {
          consumed: true,
          result: redirectResult.result,
          realtimeState: redirectResult.realtimeState,
          bookingFlowLoaded: redirectResult.bookingFlowLoaded,
          hangupRequestedByTool: redirectResult.hangupRequestedByTool,
          callEnding: redirectResult.callEnding,
          resetLastUserDigits: redirectResult.resetLastUserDigits,
        };
      }

      const blockedResult: RealtimeToolResult = {
        ok: false,
        error: "BOOKING_SMS_CONSENT_REQUIRED",
        message: "BOOKING_SMS_CONSENT_REQUIRED",
        next_required_step: null,
      };

      console.warn("[VOICE_REALTIME][BOOKING_SMS_BLOCKED_WITHOUT_PENDING_STEP]", {
        callSid,
        pendingActionGranted,
        pendingActionToolName,
        lastUserTranscript: clean(lastUserTranscript || ""),
      });

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
          instructions: [
            "Use only the tool result as source of truth.",
            "Do not call the blocked tool again.",
            "The required booking confirmation state is missing.",
            "Call get_booking_flow to recover the current configured booking step.",
            "Do not invent a consent question.",
          ].join(" "),
        },
        "tool_guard:missing_pending_booking_step"
      );

      return {
        consumed: true,
        result: blockedResult,
        realtimeState,
        bookingFlowLoaded,
        hangupRequestedByTool: false,
        callEnding,
        resetLastUserDigits: true,
      };
    }
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

  if (toolName === "submit_booking_step") {
    const submittedStepKey = clean(toolArgs.step_key || "");
    const pendingStepKey = clean(realtimeState.pendingBookingStepKey || "");
    const currentTranscript = clean(lastUserTranscript || "");
    const promptAnchorTranscript = clean(
      realtimeState.pendingBookingStepPromptAnchorTranscript || ""
    );

    const lastSubmittedStepKey = clean(
      realtimeState.lastSubmittedBookingStepKey || ""
    );

    const lastSubmittedTranscript = clean(
      realtimeState.lastSubmittedBookingTranscript || ""
    );

    const hasPendingStepState = Boolean(pendingStepKey);
    const hasPromptAnchorTranscript = Boolean(promptAnchorTranscript);

    const isSubmittingExpectedPendingStep =
      hasPendingStepState && submittedStepKey === pendingStepKey;

    const hasNewHumanTranscript =
      Boolean(currentTranscript) &&
      (!hasPromptAnchorTranscript || currentTranscript !== promptAnchorTranscript);

    const isDuplicateSubmit =
      Boolean(submittedStepKey) &&
      Boolean(currentTranscript) &&
      submittedStepKey === lastSubmittedStepKey &&
      currentTranscript === lastSubmittedTranscript;

    const shouldBlockStaleSubmit =
      !hasNewHumanTranscript || isDuplicateSubmit;

    if (shouldBlockStaleSubmit) {
      const blockedResult = buildBlockedBookingStepResult(
        "BOOKING_STEP_WAITING_FOR_NEW_USER_INPUT"
      );

      console.warn("[VOICE_REALTIME][BOOKING_STEP_SUBMIT_BLOCKED_STALE_OR_DUPLICATE_INPUT]", {
        callSid,
        submittedStepKey,
        pendingStepKey,
        currentTranscript,
        promptAnchorTranscript,
        lastSubmittedStepKey,
        lastSubmittedTranscript,
        hasPendingStepState,
        hasPromptAnchorTranscript,
        isSubmittingExpectedPendingStep,
        hasNewHumanTranscript,
        isDuplicateSubmit,
        shouldBlockStaleSubmit,
      });

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
          instructions: [
            "Use only the tool result as source of truth.",
            "Do not call submit_booking_step again yet.",
            "The caller has not provided a new answer for the current booking step.",
            "Ask or wait for the current pending booking question only.",
            "Do not advance to another booking step.",
          ].join(" "),
        },
        "tool_guard:booking_step_waiting_for_new_user_input"
      );

      return {
        consumed: true,
        result: blockedResult,
        realtimeState,
        bookingFlowLoaded,
        hangupRequestedByTool: false,
        callEnding,
        resetLastUserDigits: false,
      };
    }
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

    const submittedBookingStepKey =
      toolName === "submit_booking_step"
        ? clean((effectiveToolArgs as any)?.step_key || "")
        : "";

    const hasSubmittedPendingBookingStep =
      Boolean(submittedBookingStepKey) &&
      submittedBookingStepKey ===
        clean(realtimeState.pendingBookingStepKey || "");

    const actionRequiredToolName = clean(
      (toolResult as any)?.action_required || ""
    );

    const pendingActionGranted =
      hasSubmittedPendingBookingStep &&
      toolResult?.ok === true &&
      Boolean(actionRequiredToolName);

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

      pendingBookingStepRequired:
        shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
          ? undefined
          : nextRequiredStep?.required === true,

      pendingBookingStepPrompt:
        shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
          ? undefined
          : clean(nextRequiredStep?.prompt || "") || undefined,

      pendingBookingStepPromptAnchorTranscript:
        shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
          ? undefined
          : clean(lastUserTranscript || ""),

      lastSubmittedBookingStepKey:
        toolName === "submit_booking_step"
          ? clean((effectiveToolArgs as any)?.step_key || "")
          : realtimeState.lastSubmittedBookingStepKey,

      lastSubmittedBookingTranscript:
        toolName === "submit_booking_step"
          ? clean(lastUserTranscript || "")
          : realtimeState.lastSubmittedBookingTranscript,

      pendingActionGranted:
        toolName === "send_booking_sms" || toolName === "end_call"
          ? undefined
          : pendingActionGranted
            ? true
            : realtimeState.pendingActionGranted,

      pendingActionAnswered:
        hasSubmittedPendingBookingStep &&
        toolResult?.ok === true &&
        Boolean(actionRequiredToolName)
          ? true
          : realtimeState.pendingActionAnswered,

      pendingActionToolName:
        toolName === "send_booking_sms" || toolName === "end_call"
          ? undefined
          : pendingActionGranted
            ? actionRequiredToolName
            : realtimeState.pendingActionToolName,

      awaitingPostBookingClosure:
        toolName === "send_booking_sms" && toolResult?.ok === true
          ? true
          : (realtimeState as any)?.awaitingPostBookingClosure,

      postBookingClosureTranscript:
        toolName === "send_booking_sms" && toolResult?.ok === true
          ? clean(lastUserTranscript || "")
          : (realtimeState as any)?.postBookingClosureTranscript,
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