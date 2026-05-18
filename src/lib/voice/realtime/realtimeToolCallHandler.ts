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

function shouldBlockEndCallForPendingStep(state: CallState): boolean {
  const pendingBookingStepKey = clean(state.pendingBookingStepKey || "");

  if (pendingBookingStepKey) {
    return true;
  }

  const awaitingPostBookingClosure =
    (state as any)?.awaitingPostBookingClosure === true;

  if (!awaitingPostBookingClosure) {
    return false;
  }

  const postBookingClosureTranscriptSeq =
    typeof (state as any)?.postBookingClosureTranscriptSeq === "number"
      ? (state as any).postBookingClosureTranscriptSeq
      : null;

  const currentTranscriptSeq =
    typeof state.lastUserTranscriptSeq === "number"
      ? state.lastUserTranscriptSeq
      : null;

  if (postBookingClosureTranscriptSeq === null || currentTranscriptSeq === null) {
    return true;
  }

  return currentTranscriptSeq <= postBookingClosureTranscriptSeq;
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
    const blockedResult: RealtimeToolResult = {
      ok: false,
      error: "END_CALL_BLOCKED_PENDING_BOOKING_STEP",
      message:
        "The call cannot end yet because the booking flow is still waiting for the caller.",
    };

    console.warn("[VOICE_REALTIME][END_CALL_BLOCKED_PENDING_BOOKING_STEP]", {
      callSid,
      pendingBookingStepKey: clean(realtimeState.pendingBookingStepKey || ""),
      awaitingPostBookingClosure:
        (realtimeState as any)?.awaitingPostBookingClosure === true,
      lastUserTranscript: clean(lastUserTranscript || ""),
      lastUserTranscriptSeq: realtimeState.lastUserTranscriptSeq,
      postBookingClosureTranscriptSeq:
        (realtimeState as any)?.postBookingClosureTranscriptSeq,
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
          "The booking flow is still waiting for the caller.",
          "Ask the current pending question briefly.",
          "Ask only one question and wait.",
        ].join(" "),
      },
      "tool_guard:end_call_blocked_pending_booking_step"
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

    const currentTranscriptSeq =
      typeof realtimeState.lastUserTranscriptSeq === "number"
        ? realtimeState.lastUserTranscriptSeq
        : 0;

    const promptAnchorSeq =
      typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number"
        ? realtimeState.pendingBookingStepPromptAnchorSeq
        : -1;

    const lastSubmittedTranscriptSeq =
      typeof realtimeState.lastSubmittedBookingTranscriptSeq === "number"
        ? realtimeState.lastSubmittedBookingTranscriptSeq
        : -1;

    const hasNewHumanTranscript =
      Boolean(currentTranscript) && currentTranscriptSeq > promptAnchorSeq;

    const isDuplicateSubmit =
      Boolean(submittedStepKey) &&
      submittedStepKey === lastSubmittedStepKey &&
      currentTranscriptSeq === lastSubmittedTranscriptSeq;

    const modelSubmittedValue = clean(toolArgs.value || "");
    const hasModelSubmittedValue = modelSubmittedValue.length > 0;

    /**
     * Realtime can call submit_booking_step with the correct interpreted value
     * before lastUserTranscriptSeq is updated.
     *
     * If the model submitted a value for the expected pending step, do not block
     * only because lastUserTranscript still looks stale.
     */
    const shouldAllowModelValueForPendingStep =
      isSubmittingExpectedPendingStep && hasModelSubmittedValue && !isDuplicateSubmit;

    const shouldBlockStaleSubmit =
      !shouldAllowModelValueForPendingStep &&
      (!hasNewHumanTranscript || isDuplicateSubmit);

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
        currentTranscriptSeq,
        promptAnchorSeq,
        lastSubmittedTranscriptSeq,
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
            "The caller has not provided a valid new answer for the current booking step.",
            "Ask the current pending booking question again briefly.",
            "Do not advance to another booking step.",
          ].join(" "),
        },
        "tool_guard:booking_step_invalid_or_duplicate_input"
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

          /**
           * IMPORTANT:
           * The model value is already the interpreted answer for the current step.
           * Do not replace it with lastUserTranscript because lastUserTranscript can
           * still contain the previous step audio/transcript.
           */
          value: clean(toolArgs.value || lastUserTranscript || ""),

          raw_transcript_value: clean(lastUserTranscript || ""),
          model_value: clean(toolArgs.value || ""),
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

      pendingBookingStepPromptAnchorSeq:
        shouldClearPendingBookingStep || !resolvedPendingBookingStepKey
          ? undefined
          : realtimeState.lastUserTranscriptSeq,

      lastSubmittedBookingStepKey:
        toolName === "submit_booking_step"
          ? clean((effectiveToolArgs as any)?.step_key || "")
          : realtimeState.lastSubmittedBookingStepKey,

      lastSubmittedBookingTranscript:
        toolName === "submit_booking_step"
          ? clean((effectiveToolArgs as any)?.value || "")
          : realtimeState.lastSubmittedBookingTranscript,

      lastSubmittedBookingTranscriptSeq:
        toolName === "submit_booking_step"
          ? realtimeState.lastUserTranscriptSeq
          : realtimeState.lastSubmittedBookingTranscriptSeq,

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

      postBookingClosureTranscriptSeq:
        toolName === "send_booking_sms" && toolResult?.ok === true
          ? realtimeState.lastUserTranscriptSeq
          : (realtimeState as any)?.postBookingClosureTranscriptSeq,

    } as CallState;

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