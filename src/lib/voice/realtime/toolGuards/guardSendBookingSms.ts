// src/lib/voice/realtime/toolGuards/guardSendBookingSms.ts
import type WebSocket from "ws";
import type { CallState } from "../../types";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export type GuardSendBookingSmsResult =
  | {
      ok: true;
      handled: false;
    }
  | {
      ok: false;
      handled: true;
      result: RealtimeToolResult;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: boolean;
      callEnding: boolean;
      resetLastUserDigits: boolean;
    };

export async function guardSendBookingSms(params: {
  toolName: string;
  toolArgs: Record<string, any>;
  callId: string;
  openAiSocket: WebSocket;
  callSid: string | null;
  tenantId: string;
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
}): Promise<GuardSendBookingSmsResult> {
  const {
    toolName,
    callId,
    openAiSocket,
    callSid,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
  } = params;

  if (toolName !== "send_booking_sms") {
    return {
      ok: true,
      handled: false,
    };
  }

  const pendingActionGranted = realtimeState.pendingActionGranted === true;

  const pendingActionToolName = clean(realtimeState.pendingActionToolName || "");

  const canExecutePendingAction =
    pendingActionGranted && pendingActionToolName === toolName;

  if (canExecutePendingAction) {
    return {
      ok: true,
      handled: false,
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

  if (openAiSocket.readyState === openAiSocket.OPEN) {
    openAiSocket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(blockedResult),
        },
      })
    );
  }

  return {
    ok: false,
    handled: true,
    result: blockedResult,
    realtimeState,
    bookingFlowLoaded,
    hangupRequestedByTool: false,
    callEnding,
    resetLastUserDigits: true,
  };
}