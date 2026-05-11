//src/lib/voice/realtime/openaiRealtimeBridge.ts
import WebSocket from "ws";
import { buildRealtimeVoiceSession } from "./buildRealtimeVoiceSession";
import { resolveVoiceRequestContext } from "../runtime/resolveVoiceRequestContext";
import type { CallState } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";

type BridgeParams = {
  twilioSocket: WebSocket;
};

type TwilioStartPayload = {
  event: "start";
  start: {
    streamSid: string;
    callSid?: string;
    accountSid?: string;
    customParameters?: Record<string, string>;
  };
};

type TwilioMediaPayload = {
  event: "media";
  streamSid?: string;
  media: {
    payload: string;
  };
};

type TwilioStopPayload = {
  event: "stop";
  streamSid?: string;
};

type TwilioUnknownPayload = {
  event?: string;
  [key: string]: unknown;
};

function isTwilioStartEvent(event: TwilioUnknownPayload): event is TwilioStartPayload {
  return (
    event.event === "start" &&
    typeof event.start === "object" &&
    event.start !== null &&
    typeof (event.start as { streamSid?: unknown }).streamSid === "string"
  );
}

function isTwilioMediaEvent(event: TwilioUnknownPayload): event is TwilioMediaPayload {
  return (
    event.event === "media" &&
    typeof event.media === "object" &&
    event.media !== null &&
    typeof (event.media as { payload?: unknown }).payload === "string"
  );
}

function isTwilioStopEvent(event: TwilioUnknownPayload): event is TwilioStopPayload {
  return event.event === "stop";
}

function safeJsonParse(value: WebSocket.RawData): any | null {
  try {
    return JSON.parse(value.toString());
  } catch {
    return null;
  }
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function getOpenAiRealtimeUrl(model: string): string {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

function buildOpenAiSessionUpdate(params: {
  instructions: string;
  voice: string;
}): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: params.instructions,
      voice: params.voice,

      // Twilio Media Streams envía audio G.711 μ-law.
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",

      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
      },

      input_audio_transcription: {
        model: "gpt-4o-mini-transcribe",
        language: "en",
      },
      tools: [
        {
          type: "function",
          name: "create_appointment",
          description:
            "Create a real appointment only after the caller has provided service, date/time, and name. This tool checks the configured provider and creates the appointment.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              service: {
                type: "string",
                description: "The service requested by the caller.",
              },
              datetime: {
                type: "string",
                description:
                  "The requested appointment date and time in natural language, for example 'tomorrow at 10 AM'.",
              },
              datetime_iso: {
                type: "string",
                description:
                  "Optional ISO datetime if already known. Leave empty if uncertain.",
              },
              customer_name: {
                type: "string",
                description: "The caller or customer name.",
              },
              customer_phone: {
                type: "string",
                description:
                  "The customer phone number. Use the caller phone if not provided.",
              },
              customer_email: {
                type: "string",
                description: "Optional customer email.",
              },
            },
            required: ["service", "datetime", "customer_name"],
          },
        },
      ],
      tool_choice: "auto",
    },
  };
}

function sendTwilioAudio(params: {
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

export async function createOpenAiRealtimeBridge({
  twilioSocket,
}: BridgeParams): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  let streamSid: string | null = null;
  let callSid: string | null = null;
  let didNumber: string | null = null;
  let callerPhone: string | null = null;
  let tenantId: string | null = null;
  let openAiReady = false;
  let sessionConfigured = false;

  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

  const openAiSocket = new WebSocket(getOpenAiRealtimeUrl(model), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  async function configureRealtimeSessionIfReady(): Promise<void> {
    if (sessionConfigured) return;
    if (!openAiReady) return;
    if (!callSid) return;
    if (!didNumber) return;
    if (openAiSocket.readyState !== WebSocket.OPEN) return;

    const emptyState: CallState = {};

    const context = await resolveVoiceRequestContext({
      callSid,
      didNumber,
      state: emptyState,
      langParam: undefined,
      channelKey: "voice",
    });

    if (!context.ok) {
      console.warn("[VOICE_REALTIME][CONTEXT_BLOCKED]", {
        callSid,
        didNumber,
      });

      twilioSocket.close();
      return;
    }

    const session = buildRealtimeVoiceSession({
      businessName: context.brand || context.tenant.name || "the business",
      businessInfo: context.tenant.info_clave || "",
      systemPrompt: context.cfg.system_prompt || "",
      locale: context.currentLocale,
    });

    sendJson(
      openAiSocket,
      buildOpenAiSessionUpdate({
        instructions: session.instructions,
        voice: session.voice,
      })
    );

    sendJson(openAiSocket, {
      type: "response.create",
      response: {
        instructions: `Greet the caller naturally for ${context.brand}. Keep it short and ask how you can help.`,
      },
    });

    tenantId = context.tenant.id;

    sessionConfigured = true;

    console.log("[VOICE_REALTIME][SESSION_CONFIGURED]", {
      callSid,
      didNumber,
      tenantId: context.tenant.id,
      brand: context.brand,
      locale: context.currentLocale,
      voice: session.voice,
    });
  }

  openAiSocket.on("open", () => {
    openAiReady = true;

    console.log("[VOICE_REALTIME][OPENAI_CONNECTED]", {
      model,
    });

    configureRealtimeSessionIfReady().catch((error) => {
      console.error("[VOICE_REALTIME][SESSION_CONFIG_ERROR]", error);
      twilioSocket.close();
    });
  });

  openAiSocket.on("message", (raw) => {
    const event = safeJsonParse(raw);

    if (!event) return;

    if (event.type === "error") {
      console.error("[VOICE_REALTIME][OPENAI_ERROR]", JSON.stringify(event));
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      const toolName = String(event.name || "").trim();
      const callId = String(event.call_id || "").trim();

      let toolArgs: Record<string, any> = {};

      try {
        toolArgs = JSON.parse(String(event.arguments || "{}"));
      } catch {
        toolArgs = {};
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

        sendJson(openAiSocket, {
          type: "response.create",
          response: {
            instructions:
              "Tell the caller briefly that the system is not ready to complete that action yet.",
          },
        });

        return;
      }

      executeRealtimeTool({
        tenantId,
        callerPhone,
        toolName,
        args: toolArgs,
      })
        .then((toolResult) => {
          console.log("[VOICE_REALTIME][TOOL_RESULT]", {
            callSid,
            toolName,
            ok: toolResult?.ok,
            error: toolResult?.error,
          });

          sendJson(openAiSocket, {
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(toolResult),
            },
          });

          sendJson(openAiSocket, {
            type: "response.create",
            response: {
              instructions:
                "Respond to the caller using the tool result. If ok is true, confirm the appointment briefly. If ok is false, explain the issue briefly and ask one clear follow-up question.",
            },
          });
        })
        .catch((error) => {
          console.error("[VOICE_REALTIME][TOOL_ERROR]", {
            callSid,
            toolName,
            error: error instanceof Error ? error.message : String(error),
          });

          sendJson(openAiSocket, {
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : "TOOL_ERROR",
              }),
            },
          });

          sendJson(openAiSocket, {
            type: "response.create",
            response: {
              instructions:
                "Tell the caller briefly that this time could not be confirmed and ask for another day or time.",
            },
          });
        });

      return;
    }

    const audioDelta =
      typeof event.delta === "string" &&
      (event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta")
        ? event.delta
        : null;

    if (audioDelta && streamSid) {
      sendTwilioAudio({
        twilioSocket,
        streamSid,
        payload: audioDelta,
      });
      return;
    }

    if (
      event.type === "response.audio_transcript.done" ||
      event.type === "conversation.item.input_audio_transcription.completed"
    ) {
      console.log("[VOICE_REALTIME][TRANSCRIPT]", {
        callSid,
        transcript: event.transcript,
      });
    }

    if (event.type === "response.done") {
      console.log("[VOICE_REALTIME][RESPONSE_DONE]", {
        callSid,
      });
    }
  });

  openAiSocket.on("close", (code, reason) => {
    console.log("[VOICE_REALTIME][OPENAI_CLOSED]", {
      callSid,
      code,
      reason: reason.toString(),
    });

    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
  });

  openAiSocket.on("error", (error) => {
    console.error("[VOICE_REALTIME][OPENAI_SOCKET_ERROR]", error);

    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
  });

  twilioSocket.on("message", (raw) => {
    const event = safeJsonParse(raw) as TwilioUnknownPayload | null;

    if (!event) return;

    if (isTwilioStartEvent(event)) {
      streamSid = event.start.streamSid;
      callSid = event.start.callSid || null;
      didNumber = event.start.customParameters?.didNumber || null;

      callerPhone = event.start.customParameters?.callerPhone || null;

      console.log("[VOICE_REALTIME][TWILIO_START]", {
        callSid,
        streamSid,
        didNumber,
      });

      configureRealtimeSessionIfReady().catch((error) => {
        console.error("[VOICE_REALTIME][SESSION_CONFIG_ERROR]", error);
        twilioSocket.close();
      });

      return;
    }

    if (isTwilioMediaEvent(event)) {
      if (!openAiReady || openAiSocket.readyState !== WebSocket.OPEN) return;

      sendJson(openAiSocket, {
        type: "input_audio_buffer.append",
        audio: event.media.payload,
      });

      return;
    }

    if (isTwilioStopEvent(event)) {
      console.log("[VOICE_REALTIME][TWILIO_STOP]", {
        callSid,
        streamSid,
      });

      if (openAiSocket.readyState === WebSocket.OPEN) {
        openAiSocket.close();
      }

      return;
    }
  });

  twilioSocket.on("close", () => {
    console.log("[VOICE_REALTIME][TWILIO_CLOSED]", {
      callSid,
      streamSid,
    });

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  twilioSocket.on("error", (error) => {
    console.error("[VOICE_REALTIME][TWILIO_SOCKET_ERROR]", error);

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });
}