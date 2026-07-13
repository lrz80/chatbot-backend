//src/lib/voice/realtime/humanTransferController.ts
import WebSocket from "ws";

import type { CallState, VoiceLocale } from "../types";
import { transferTwilioCall } from "./twilioRealtimeTransport";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string,
  options?: {
    sendToolOutputToOpenAi?: boolean;
    endCallGoodbye?: boolean;
  }
) => void;

type CreateHumanTransferControllerParams = {
  twilioSocket: WebSocket;

  getStreamSid: () => string | null;
  getCallSid: () => string | null;
  getTwilioAccountSid: () => string | null;
  getCurrentLocale: () => VoiceLocale;
  getRealtimeState: () => CallState;
  getLastAssistantTranscript: () => string;
  getCallEnding: () => boolean;

  setRealtimeState: (state: CallState) => void;
  setCallEnding: (value: boolean) => void;

  requestRealtimeResponse: RequestRealtimeResponse;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendTwilioMark(params: {
  twilioSocket: WebSocket;
  streamSid: string | null;
  markName: string;
}): boolean {
  if (!params.streamSid) return false;
  if (params.twilioSocket.readyState !== WebSocket.OPEN) return false;

  params.twilioSocket.send(
    JSON.stringify({
      event: "mark",
      streamSid: params.streamSid,
      mark: {
        name: params.markName,
      },
    })
  );

  return true;
}

function resolveTransferFallbackMs(transcript: string): number {
  const configured = Number(
    process.env.REALTIME_TRANSFER_FALLBACK_MS
  );

  if (Number.isFinite(configured) && configured >= 2000) {
    return Math.min(configured, 15000);
  }

  const words = clean(transcript)
    .split(/\s+/)
    .filter(Boolean).length;

  const estimatedSpeechMs = Math.ceil(
    (words / 2.4) * 1000
  );

  return Math.min(
    Math.max(estimatedSpeechMs + 1800, 3500),
    10000
  );
}

function clearPendingTransferState(
  state: CallState
): CallState {
  return {
    ...state,
    pendingHumanTransfer: false,
    pendingHumanTransferNumber: null,
    pendingHumanTransferAnnouncement: false,
  } as CallState;
}

export function createHumanTransferController(
  params: CreateHumanTransferControllerParams
) {
  let transferPlaybackMarkName: string | null = null;
  let transferFallbackTimer: NodeJS.Timeout | null = null;
  let transferExecutionStarted = false;

  function clearFallbackTimer(): void {
    if (!transferFallbackTimer) return;

    clearTimeout(transferFallbackTimer);
    transferFallbackTimer = null;
  }

  async function performPendingTransfer(
    source: string
  ): Promise<void> {
    if (transferExecutionStarted) {
      return;
    }

    if (params.getCallEnding()) {
      return;
    }

    const realtimeState = params.getRealtimeState();

    const representativeNumber = clean(
      (realtimeState as any)
        .pendingHumanTransferNumber
    );

    if (!representativeNumber) {
      console.error(
        "[VOICE_REALTIME][HUMAN_TRANSFER_EXECUTION_SKIPPED]",
        {
          callSid: params.getCallSid(),
          source,
          reason: "PENDING_TRANSFER_NUMBER_MISSING",
        }
      );

      return;
    }

    transferExecutionStarted = true;
    transferPlaybackMarkName = null;
    clearFallbackTimer();

    console.log(
      "[VOICE_REALTIME][HUMAN_TRANSFER_EXECUTING_AFTER_ANNOUNCEMENT]",
      {
        callSid: params.getCallSid(),
        source,
        representativeNumber,
      }
    );

    const transferResult = await transferTwilioCall({
      callSid: params.getCallSid(),
      accountSid: params.getTwilioAccountSid(),
      representativeNumber,
    });

    if (!transferResult.ok) {
      transferExecutionStarted = false;

      params.setRealtimeState(
        clearPendingTransferState(
          params.getRealtimeState()
        )
      );

      console.error(
        "[VOICE_REALTIME][HUMAN_TRANSFER_EXECUTION_FAILED]",
        {
          callSid: params.getCallSid(),
          source,
          error: transferResult.error,
        }
      );

      params.requestRealtimeResponse(
        {
          tool_choice: "none",
          instructions: [
            `Respond in the caller's active locale: ${params.getCurrentLocale()}.`,
            "Briefly explain that the call could not be transferred right now.",
            "Do not mention Twilio, tools, APIs, configuration, backend errors, or technical details.",
            "Ask one short question offering assistance.",
          ].join("\n"),
        },
        "tool_followup:transfer_to_human:execution_error",
        {
          sendToolOutputToOpenAi: false,
        }
      );

      return;
    }

    params.setRealtimeState(
      clearPendingTransferState(
        params.getRealtimeState()
      )
    );

    params.setCallEnding(true);

    console.log(
      "[VOICE_REALTIME][HUMAN_TRANSFER_COMPLETED]",
      {
        callSid: params.getCallSid(),
        source,
        representativeNumber,
      }
    );
  }

  function scheduleAfterAnnouncement(
    source: string
  ): void {
    if (transferExecutionStarted) return;
    if (params.getCallEnding()) return;

    const realtimeState = params.getRealtimeState();

    const representativeNumber = clean(
      (realtimeState as any)
        .pendingHumanTransferNumber
    );

    if (!representativeNumber) {
      console.error(
        "[VOICE_REALTIME][HUMAN_TRANSFER_MARK_SKIPPED]",
        {
          callSid: params.getCallSid(),
          source,
          reason: "PENDING_TRANSFER_NUMBER_MISSING",
        }
      );

      return;
    }

    const markName = `human-transfer:${Date.now()}`;

    transferPlaybackMarkName = markName;

    const markSent = sendTwilioMark({
      twilioSocket: params.twilioSocket,
      streamSid: params.getStreamSid(),
      markName,
    });

    const announcement =
      params.getLastAssistantTranscript();

    const fallbackMs =
      resolveTransferFallbackMs(announcement);

    console.log(
      "[VOICE_REALTIME][HUMAN_TRANSFER_SCHEDULED_AFTER_ANNOUNCEMENT]",
      {
        callSid: params.getCallSid(),
        source,
        markName,
        markSent,
        fallbackMs,
        representativeNumber,
        announcement,
      }
    );

    clearFallbackTimer();

    transferFallbackTimer = setTimeout(() => {
      void performPendingTransfer(
        "human_transfer_mark_fallback_timeout"
      );
    }, fallbackMs);
  }

  function handleTwilioMark(
    markName: string
  ): boolean {
    const normalizedMarkName = clean(markName);

    if (
      !transferPlaybackMarkName ||
      normalizedMarkName !== transferPlaybackMarkName
    ) {
      return false;
    }

    transferPlaybackMarkName = null;

    void performPendingTransfer(
      "twilio_human_transfer_mark_received"
    );

    return true;
  }

  function reset(): void {
    clearFallbackTimer();

    transferPlaybackMarkName = null;
    transferExecutionStarted = false;
  }

  return {
    scheduleAfterAnnouncement,
    handleTwilioMark,
    reset,
  };
}