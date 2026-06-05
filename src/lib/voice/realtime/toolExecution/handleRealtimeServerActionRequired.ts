//src/lib/voice/realtime/toolExecution/handleRealtimeServerActionRequired.ts
import type { CallState } from "../../types";
import { executeRealtimeTool } from "../realtimeToolExecutor";
import type { RealtimeToolResult } from "../buildToolFollowupInstructions";
import { resolveRealtimeToolFollowupInstructions } from "../toolFollowup/resolveRealtimeToolFollowupInstructions";
import { clean } from "../utils/clean";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

type HandleRealtimeServerActionRequiredParams = {
  toolName: string;
  toolResult: RealtimeToolResult;
  actionRequired: string;
  resolvedTenantId: string;
  callerPhone: string | null;
  didNumber: string | null;
  realtimeTenant: any;
  realtimeCfg: any;
  callSid: string | null;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  nextRealtimeState: CallState;
  bookingFlowLoaded: boolean;
  nextBookingFlowLoaded: boolean;
  callEnding: boolean;
  nextCallEnding: boolean;
  lastUserTranscript: string;
  lastUserDigits: string;
  requestRealtimeResponse: RequestRealtimeResponse;
};

type HandleRealtimeServerActionRequiredResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      result: RealtimeToolResult;
      realtimeState: CallState;
      bookingFlowLoaded: boolean;
      hangupRequestedByTool: boolean;
      callEnding: boolean;
      resetLastUserDigits: true;
    };

const SERVER_EXECUTABLE_ACTIONS = new Set(["create_appointment"]);

export async function handleRealtimeServerActionRequired(
  params: HandleRealtimeServerActionRequiredParams
): Promise<HandleRealtimeServerActionRequiredResult> {
  const {
    toolName,
    toolResult,
    actionRequired,
    resolvedTenantId,
    callerPhone,
    didNumber,
    realtimeTenant,
    realtimeCfg,
    callSid,
    currentLocale,
    realtimeState,
    nextRealtimeState,
    nextBookingFlowLoaded,
    nextCallEnding,
    lastUserTranscript,
    lastUserDigits,
    requestRealtimeResponse,
  } = params;

  if (
    toolName !== "submit_booking_step" ||
    toolResult?.ok !== true ||
    !SERVER_EXECUTABLE_ACTIONS.has(actionRequired)
  ) {
    return { handled: false };
  }

  console.warn("[VOICE_REALTIME][SERVER_ACTION_REQUIRED_EXECUTING]", {
    callSid,
    toolName,
    actionRequired,
  });

  const serverActionResult = await executeRealtimeTool({
    tenantId: resolvedTenantId,
    callerPhone,
    toolName: actionRequired,
    args: {},
    tenant: realtimeTenant,
    cfg: realtimeCfg,
    callSid: callSid || undefined,
    didNumber: didNumber || undefined,
    currentLocale,
    state: nextRealtimeState,
    userInput: lastUserTranscript,
    digits: lastUserDigits,
  });

  console.log("[VOICE_REALTIME][SERVER_ACTION_RESULT]", {
    callSid,
    actionRequired,
    ok: serverActionResult?.ok,
    error: serverActionResult?.error,
    message: serverActionResult?.message,
  });

  const followupInstructions = resolveRealtimeToolFollowupInstructions({
    toolName: actionRequired,
    toolResult: (serverActionResult || {}) as RealtimeToolResult,
    currentLocale:
      clean((nextRealtimeState as any)?.lang) ||
      clean((realtimeState as any)?.lang) ||
      currentLocale,
  });

  const finalFollowupInstructions =
    clean(followupInstructions) ||
    clean((serverActionResult as any)?.message || "");

  if (finalFollowupInstructions) {
    requestRealtimeResponse(
      {
        instructions: finalFollowupInstructions,
        tool_choice: "none",
      },
      `tool_followup:${actionRequired}`
    );
  }

  return {
    handled: true,
    result: serverActionResult as RealtimeToolResult,
    realtimeState: nextRealtimeState,
    bookingFlowLoaded: nextBookingFlowLoaded,
    hangupRequestedByTool:
      actionRequired === "end_call" && serverActionResult?.ok === true,
    callEnding: nextCallEnding,
    resetLastUserDigits: true,
  };
}