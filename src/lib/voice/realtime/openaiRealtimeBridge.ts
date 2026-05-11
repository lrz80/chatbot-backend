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

type RealtimeToolResult = {
  ok?: boolean;
  error?: string;
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

function normalizeLocale(locale?: string): "en-US" | "es-ES" | "pt-BR" {
  const value = String(locale || "").trim().toLowerCase();

  if (value.startsWith("es")) return "es-ES";
  if (value.startsWith("pt")) return "pt-BR";
  return "en-US";
}

function getRealtimeTranscriptionLanguage(locale?: string): "en" | "es" | "pt" {
  const normalized = normalizeLocale(locale);

  if (normalized === "es-ES") return "es";
  if (normalized === "pt-BR") return "pt";
  return "en";
}

function buildInitialGreetingInstruction(params: {
  brand: string;
  locale?: string;
}): string {
  const normalized = normalizeLocale(params.locale);

  if (normalized === "es-ES") {
    return `Greet the caller in Spanish for ${params.brand}. Keep it short and natural.`;
  }

  if (normalized === "pt-BR") {
    return `Greet the caller in Brazilian Portuguese for ${params.brand}. Keep it short and natural.`;
  }

  return `Greet the caller in English for ${params.brand}. Keep it short and natural.`;
}

function buildOpenAiSessionUpdate(params: {
  instructions: string;
  voice: string;
  transcriptionLanguage: "en" | "es" | "pt";
}): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: params.instructions,
      voice: params.voice,
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
        language: params.transcriptionLanguage,
      },
      tools: [
        {
          type: "function",
          name: "get_booking_flow",
          description:
            "Get the tenant-configured booking flow steps. Call this before starting any appointment booking. Follow these steps in order and do not skip required steps.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
        {
          type: "function",
          name: "create_appointment",
          description:
            "Create a real appointment ONLY after all required booking flow fields configured by the business have been collected and the caller explicitly confirmed the final details. Never skip tenant-configured booking steps.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              service: {
                type: "string",
                description: "The canonical service requested by the caller.",
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
                description: "The human customer name, not the pet name.",
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
              pet_name: {
                type: "string",
                description: "The pet name only.",
              },
              pet_weight: {
                type: "string",
                description: "The pet weight only.",
              },
              location_detail: {
                type: "string",
                description:
                  "Appointment location detail such as salon or mobile.",
              },
              customer_confirmed: {
                type: "boolean",
                description:
                  "True only if the caller explicitly confirmed the final appointment details after all required booking questions were completed.",
              },
            },
            required: [
              "service",
              "datetime",
              "customer_name",
              "customer_confirmed",
            ],
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

function buildToolFollowupInstructions(params: {
  toolName: string;
  toolResult: RealtimeToolResult;
}): string {
  const { toolName, toolResult } = params;
  const ok = toolResult?.ok === true;
  const error = String(toolResult?.error || "").trim();

  if (toolName === "get_booking_flow") {
    if (ok) {
      return [
        "The booking flow is now available.",
        "Do not confirm any appointment.",
        "Ask only the next required booking question from the configured step order.",
        "If the caller already provided a value for an earlier or later step and the tool result includes it, preserve it and ask only for the next still-missing required step.",
        "Ask one short question only.",
      ].join(" ");
    }

    return [
      "Tell the caller briefly that booking cannot continue right now.",
      "Do not invent booking steps.",
      "Ask one short follow-up question only if needed.",
    ].join(" ");
  }

  if (toolName === "create_appointment") {
    if (ok) {
      return [
        "Confirm the appointment briefly using only the tool result as the source of truth.",
        "Do not invent details.",
        "Then ask if the caller needs anything else.",
      ].join(" ");
    }

    if (error === "MISSING_FINAL_CONFIRMATION") {
      return [
        "Do not say the appointment was created.",
        "Present one short final summary of the appointment details already collected.",
        "Ask for explicit confirmation.",
        "Ask one short confirmation question only.",
      ].join(" ");
    }

    return [
      "Do not say the appointment was created.",
      "Explain the issue briefly using the tool result.",
      "Ask one clear follow-up question.",
    ].join(" ");
  }

  if (ok) {
    return "Respond briefly using the tool result as the source of truth.";
  }

  return "Explain the issue briefly and ask one clear follow-up question.";
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
  let currentLocale: "en-US" | "es-ES" | "pt-BR" = "en-US";
  let bookingFlowLoaded = false;

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

    currentLocale = normalizeLocale(context.currentLocale);

    const session = buildRealtimeVoiceSession({
      businessName: context.brand || context.tenant.name || "the business",
      businessInfo: context.tenant.info_clave || "",
      systemPrompt: context.cfg.system_prompt || "",
      locale: currentLocale,
    });

    sendJson(
      openAiSocket,
      buildOpenAiSessionUpdate({
        instructions: session.instructions,
        voice: session.voice,
        transcriptionLanguage: getRealtimeTranscriptionLanguage(currentLocale),
      })
    );

    sendJson(openAiSocket, {
      type: "response.create",
      response: {
        instructions: buildInitialGreetingInstruction({
          brand: context.brand || context.tenant.name || "the business",
          locale: currentLocale,
        }),
      },
    });

    tenantId = context.tenant.id;
    sessionConfigured = true;

    console.log("[VOICE_REALTIME][SESSION_CONFIGURED]", {
      callSid,
      didNumber,
      tenantId: context.tenant.id,
      brand: context.brand,
      locale: currentLocale,
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

      if (toolName === "create_appointment" && !bookingFlowLoaded) {
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

        sendJson(openAiSocket, {
          type: "response.create",
          response: {
            instructions: [
              "Do not say the appointment was created.",
              "Tell the caller briefly that you first need to collect the required booking details.",
              "Call get_booking_flow before continuing the booking.",
            ].join(" "),
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
          if (toolName === "get_booking_flow" && toolResult?.ok) {
            bookingFlowLoaded = true;
          }

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
              instructions: buildToolFollowupInstructions({
                toolName,
                toolResult: (toolResult || {}) as RealtimeToolResult,
              }),
            },
          });
        })
        .catch((error) => {
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

          sendJson(openAiSocket, {
            type: "response.create",
            response: {
              instructions: buildToolFollowupInstructions({
                toolName,
                toolResult: toolErrorResult,
              }),
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