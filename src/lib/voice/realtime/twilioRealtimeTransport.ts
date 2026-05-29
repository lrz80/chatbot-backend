//src/lib/voice/realtime/twilioRealtimeTransport.ts
import WebSocket from "ws";
import twilio from "twilio";

export type TwilioStartPayload = {
  event: "start";
  start: {
    streamSid: string;
    callSid?: string;
    accountSid?: string;
    customParameters?: Record<string, string>;
  };
};

export type TwilioMediaPayload = {
  event: "media";
  streamSid?: string;
  media: {
    payload: string;
  };
};

export type TwilioStopPayload = {
  event: "stop";
  streamSid?: string;
};

export type TwilioUnknownPayload = {
  event?: string;
  [key: string]: unknown;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function isTwilioStartEvent(
  event: TwilioUnknownPayload
): event is TwilioStartPayload {
  return (
    event.event === "start" &&
    typeof event.start === "object" &&
    event.start !== null &&
    typeof (event.start as { streamSid?: unknown }).streamSid === "string"
  );
}

export function isTwilioMediaEvent(
  event: TwilioUnknownPayload
): event is TwilioMediaPayload {
  return (
    event.event === "media" &&
    typeof event.media === "object" &&
    event.media !== null &&
    typeof (event.media as { payload?: unknown }).payload === "string"
  );
}

export function isTwilioStopEvent(
  event: TwilioUnknownPayload
): event is TwilioStopPayload {
  return event.event === "stop";
}

export function sendTwilioAudio(params: {
  twilioSocket: WebSocket;
  streamSid: string;
  payload: string;
}): void {
  sendJson(params.twilioSocket, {
    event: "media",
    streamSid: params.streamSid,
    media: {
      payload: params.payload,
    },
  });
}

export async function endTwilioCall(params: {
  callSid: string | null;
  accountSid?: string | null;
}): Promise<void> {
  const callSid = params.callSid;
  if (!callSid) return;

  const envAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || "";
  const envAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";

  const incomingAccountSid = clean(params.accountSid);

  const authAccountSid = envAccountSid;
  const authToken = envAuthToken;
  const targetAccountSid = incomingAccountSid || envAccountSid;

  if (!authAccountSid || !authToken || !targetAccountSid) {
    console.warn("[VOICE_REALTIME][TWILIO_HANGUP_SKIPPED]", {
      callSid,
      reason: "MISSING_TWILIO_CREDENTIALS",
      authAccountSid,
      targetAccountSid,
    });
    return;
  }

  try {
    const client = twilio(authAccountSid, authToken, {
      accountSid: targetAccountSid,
    });

    await client.calls(callSid).update({
      status: "completed",
    });
  } catch (error) {
    console.error("[VOICE_REALTIME][TWILIO_HANGUP_ERROR]", {
      callSid,
      authAccountSid,
      targetAccountSid,
      incomingAccountSid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}