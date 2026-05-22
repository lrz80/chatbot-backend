//src/lib/voice/realtime/openaiRealtimeBridge.ts

import WebSocket from "ws";
import twilio from "twilio";
import { buildRealtimeVoiceSession } from "./buildRealtimeVoiceSession";
import { resolveVoiceRequestContext } from "../runtime/resolveVoiceRequestContext";
import type { CallState } from "../types";

import { handleRealtimeToolCall } from "./realtimeToolCallHandler";
import { buildOpenAiRealtimeSessionUpdate } from "./buildOpenAiRealtimeSessionUpdate";
import { handleUserTranscriptCompleted } from "./realtimeTranscriptRuntime";
import {
  attachLatestUserTranscriptSeq,
  mergeTranscriptStatePreservingBookingRuntime,
} from "./bookingRuntimeState";

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

function normalizeLocale(locale?: string): "en-US" | "es-ES" | "pt-BR" {
  const value = String(locale || "").trim().toLowerCase();

  if (value.startsWith("es")) return "es-ES";
  if (value.startsWith("pt")) return "pt-BR";
  return "en-US";
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
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

function resolveConfiguredWelcomeMessage(params: {
  cfg: any;
  tenant: any;
}): string {
  const cfgWelcome =
    clean(params.cfg?.welcome_message) ||
    clean(params.cfg?.welcomeMessage) ||
    clean(params.cfg?.mensaje_bienvenida) ||
    clean(params.cfg?.bienvenida);

  if (cfgWelcome) {
    return cfgWelcome;
  }

  const tenantWelcome =
    clean(params.tenant?.welcome_message) ||
    clean(params.tenant?.welcomeMessage) ||
    clean(params.tenant?.mensaje_bienvenida) ||
    clean(params.tenant?.bienvenida);

  return tenantWelcome;
}

function buildInitialGreetingFromConfiguredWelcome(params: {
  configuredWelcome: string;
  brand: string;
  locale: "en-US" | "es-ES" | "pt-BR";
}): string {
  const configuredWelcome = clean(params.configuredWelcome);

  if (!configuredWelcome) {
    return buildInitialGreetingInstruction({
      brand: params.brand,
      locale: params.locale,
    });
  }

  return [
    "Use only this configured welcome message as the source of truth.",
    "Say it naturally as the first greeting of the phone call.",
    "Do not replace it with a generic greeting.",
    "Do not invent another business name.",
    "Do not add menu options unless they are already included in the configured welcome message.",
    `Configured welcome message: ${configuredWelcome}`,
  ].join(" ");
}

function refreshRealtimeSession(params: {
  openAiSocket: WebSocket;
  model: string;
  locale: "en-US" | "es-ES" | "pt-BR";
  businessName: string;
  businessInfo?: string | null;
  systemPrompt?: string | null;
}): { voice: string } | null {
  if (params.openAiSocket.readyState !== WebSocket.OPEN) return null;

  const session = buildRealtimeVoiceSession({
    businessName: params.businessName,
    businessInfo: params.businessInfo || "",
    systemPrompt: params.systemPrompt || "",
    locale: params.locale,
  });

  sendJson(
    params.openAiSocket,
    buildOpenAiRealtimeSessionUpdate({
    instructions: session.instructions,
    voice: session.voice,
    model: params.model,
  })
  );

  return {
    voice: session.voice,
  };
}

async function refreshRealtimeVoiceContext(params: {
  callSid: string | null;
  didNumber: string | null;
  currentLocale: "en-US" | "es-ES" | "pt-BR";
  realtimeState: CallState;
}): Promise<{
  tenantId: string | null;
  tenant: any;
  cfg: any;
  brand: string;
  voiceName: string | null;
} | null> {
  if (!params.callSid || !params.didNumber) return null;

  const context = await resolveVoiceRequestContext({
    callSid: params.callSid,
    didNumber: params.didNumber,
    state: {
      ...params.realtimeState,
      lang: params.currentLocale,
    },
    langParam:
      params.currentLocale === "es-ES"
        ? "es"
        : params.currentLocale === "pt-BR"
        ? "pt"
        : "en",
    channelKey: "voice",
  });

  if (!context.ok) {
    return null;
  }

  return {
    tenantId: context.tenant.id,
    tenant: context.tenant,
    cfg: context.cfg || {},
    brand: context.brand,
    voiceName: context.voiceName || null,
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

async function endTwilioCall(params: {
  callSid: string | null;
  accountSid?: string | null;
}): Promise<void> {
  const callSid = params.callSid;
  if (!callSid) return;

  const envAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || "";
  const envAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim() || "";

  const incomingAccountSid = clean(params.accountSid);

  /**
   * TWILIO_ACCOUNT_SID can be the master account.
   * The call itself can belong to a subaccount.
   *
   * authAccountSid/authToken = credentials used to authenticate.
   * targetAccountSid = account that owns the call resource.
   */
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

    console.log("[VOICE_REALTIME][TWILIO_CALL_COMPLETED]", {
      callSid,
      authAccountSid,
      targetAccountSid,
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
  let realtimeTenant: any = null;
  let realtimeCfg: any = null;
  let realtimeState: CallState = {};
  let lastUserTranscript = "";
  let lastUserDigits = "";
  let lastUserTranscriptSeq = 0;
  let openAiReady = false;
  let sessionConfigured = false;
  let currentLocale: "en-US" | "es-ES" | "pt-BR" = "en-US";
  let bookingFlowLoaded = false;

  let realtimeToolQueue: Promise<void> = Promise.resolve();

  let activeResponseId: string | null = null;
  let pendingResponseCreate: Record<string, unknown> | null = null;

  let hangupRequestedByTool = false;
  let endCallGoodbyeRequested = false;
  let endCallGoodbyeResponseId: string | null = null;

  let callEnding = false;
  
  let localeLocked = false;
  let twilioAccountSid: string | null = null;

  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

  const openAiSocket = new WebSocket(getOpenAiRealtimeUrl(model), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  function requestRealtimeResponse(
    response?: Record<string, unknown>,
    source = "unknown"
  ): void {
    const event: Record<string, unknown> = {
      type: "response.create",
      ...(response ? { response } : {}),
    };

    const responseInstructions =
      typeof response?.instructions === "string" ? response.instructions : "";

    const isEndCallFollowup = source === "tool_followup:end_call";

    const shouldCreateEndCallGoodbye =
      isEndCallFollowup &&
      responseInstructions.includes("Say a short, natural goodbye") &&
      !responseInstructions.includes("Do not end the call yet");

    if (isEndCallFollowup && shouldCreateEndCallGoodbye) {
      endCallGoodbyeRequested = true;
      endCallGoodbyeResponseId = null;
    }

    if (isEndCallFollowup && !shouldCreateEndCallGoodbye) {
      endCallGoodbyeRequested = false;
      endCallGoodbyeResponseId = null;

      console.log("[VOICE_REALTIME][END_CALL_FOLLOWUP_NOT_GOODBYE]", {
        callSid,
        source,
      });
    }

    console.log("[VOICE_REALTIME][RESPONSE_CREATE_REQUESTED]", {
      callSid,
      source,
      activeResponseId,
      instructions:
        typeof response?.instructions === "string"
          ? response.instructions.slice(0, 500)
          : null,
    });

    if (activeResponseId) {
      pendingResponseCreate = event;

      console.warn("[VOICE_REALTIME][RESPONSE_CREATE_QUEUED]", {
        callSid,
        source,
        activeResponseId,
      });

      return;
    }

    sendJson(openAiSocket, event);
  }

  function flushPendingRealtimeResponse(): void {
    if (!pendingResponseCreate) return;
    if (activeResponseId) return;
    if (openAiSocket.readyState !== WebSocket.OPEN) return;

    const event = pendingResponseCreate;
    pendingResponseCreate = null;

    console.log("[VOICE_REALTIME][RESPONSE_CREATE_FLUSHED]", {
      callSid,
    });

    sendJson(openAiSocket, event);
  }

  function isConversationAlreadyHasActiveResponseError(event: any): boolean {
    return (
      event?.type === "error" &&
      event?.error?.code === "conversation_already_has_active_response"
    );
  }

  function enqueueRealtimeToolCall(event: any): void {
    realtimeToolQueue = realtimeToolQueue
      .then(async () => {
        const toolCallResult = await handleRealtimeToolCall({
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
        });

        if (!toolCallResult.consumed) {
          return;
        }

        realtimeState = attachLatestUserTranscriptSeq({
          realtimeState: toolCallResult.realtimeState,
          lastUserTranscriptSeq,
        });

        bookingFlowLoaded = toolCallResult.bookingFlowLoaded;

        console.log("[VOICE_REALTIME][BRIDGE_STATE_AFTER_TOOL]", {
          callSid,
          toolName: event?.name || "",
          bookingFlowLoaded,
          pendingBookingStepKey: realtimeState.pendingBookingStepKey || "",
          pendingBookingStepPromptAnchorTranscript:
            realtimeState.pendingBookingStepPromptAnchorTranscript || "",
          pendingBookingStepPromptAnchorSeq:
            typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number"
              ? realtimeState.pendingBookingStepPromptAnchorSeq
              : null,
          lastUserTranscript,
          lastUserTranscriptSeq,
        });

        if (toolCallResult.hangupRequestedByTool) {
          hangupRequestedByTool = true;
        }

        callEnding = toolCallResult.callEnding;

        if (toolCallResult.resetLastUserDigits) {
          lastUserDigits = "";
        }

      })
      .catch((error) => {
        console.error("[VOICE_REALTIME][TOOL_HANDLER_FATAL_ERROR]", {
          callSid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async function configureRealtimeSessionIfReady(): Promise<void> {
    if (sessionConfigured) return;
    if (!openAiReady) return;
    if (!callSid) return;
    if (!didNumber) return;
    if (openAiSocket.readyState !== WebSocket.OPEN) return;

    const requestState: CallState = realtimeState;

    const context = await resolveVoiceRequestContext({
      callSid,
      didNumber,
      state: requestState,
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

    currentLocale = "en-US";

    const session = buildRealtimeVoiceSession({
      businessName: context.brand || context.tenant.name || "the business",
      businessInfo: context.tenant.info_clave || "",
      systemPrompt: context.cfg.system_prompt || "",
      locale: currentLocale,
    });

    if (openAiSocket.readyState !== WebSocket.OPEN) return;
    if (twilioSocket.readyState !== WebSocket.OPEN) return;

    sendJson(
      openAiSocket,
      buildOpenAiRealtimeSessionUpdate({
        instructions: session.instructions,
        voice: session.voice,
        model,
      })
    );

    if (openAiSocket.readyState !== WebSocket.OPEN) return;
    if (twilioSocket.readyState !== WebSocket.OPEN) return;

    const configuredWelcomeMessage = resolveConfiguredWelcomeMessage({
      cfg: context.cfg || {},
      tenant: context.tenant || {},
    });

    requestRealtimeResponse(
      {
        instructions: buildInitialGreetingFromConfiguredWelcome({
          configuredWelcome: configuredWelcomeMessage,
          brand: context.brand || context.tenant.name || "the business",
          locale: currentLocale,
        }),
      },
      "bridge:initial_greeting"
    );

    tenantId = context.tenant.id;
    realtimeTenant = context.tenant;
    realtimeCfg = context.cfg || {};
    realtimeState = {
      ...realtimeState,
      lang: currentLocale,
    };
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

    if (event.type === "response.created") {
      activeResponseId = event.response?.id || null;

      if (endCallGoodbyeRequested && !endCallGoodbyeResponseId) {
        endCallGoodbyeResponseId = activeResponseId;

        console.log("[VOICE_REALTIME][END_CALL_GOODBYE_RESPONSE_CREATED]", {
          callSid,
          responseId: endCallGoodbyeResponseId,
        });
      }

      return;
    }

    if (event.type === "error") {
      if (isConversationAlreadyHasActiveResponseError(event)) {
        console.warn("[VOICE_REALTIME][RESPONSE_ALREADY_ACTIVE_IGNORED]", {
          callSid,
          activeResponseId,
        });

        return;
      }

      console.error("[VOICE_REALTIME][OPENAI_ERROR]", JSON.stringify(event));
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      enqueueRealtimeToolCall(event);
      return;
    }

    const audioDelta =
      typeof event.delta === "string" &&
      (event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta")
        ? event.delta
        : null;

    if (audioDelta && streamSid) {
      if (callEnding) {
        return;
      }

      sendTwilioAudio({
        twilioSocket,
        streamSid,
        payload: audioDelta,
      });
      return;
    }

    if (event.type === "response.audio_transcript.done") {
      /**
       * Assistant transcript.
       * Never use this as caller input.
       */
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      if (callEnding) {
        return;
      }

      handleUserTranscriptCompleted({
        event,
        callSid,
        didNumber,
        model,
        currentLocale,
        realtimeState,
        realtimeTenant,
        realtimeCfg,
        localeLocked,
        lastUserTranscriptSeq,
        refreshRealtimeVoiceContext,
        refreshRealtimeSession,
        openAiSocket,
        tenantId,
      })
        .then((runtimeResult) => {
          if (!runtimeResult.consumed) {
            return;
          }

          lastUserTranscript = runtimeResult.lastUserTranscript;
          lastUserTranscriptSeq = runtimeResult.lastUserTranscriptSeq;
          currentLocale = runtimeResult.currentLocale;
          
          const latestToolState = realtimeState;

          realtimeState = mergeTranscriptStatePreservingBookingRuntime({
            currentToolState: latestToolState,
            transcriptState: runtimeResult.realtimeState,
            lastUserTranscriptSeq: runtimeResult.lastUserTranscriptSeq,
          });

          realtimeTenant = runtimeResult.realtimeTenant;
          realtimeCfg = runtimeResult.realtimeCfg;
          localeLocked = runtimeResult.localeLocked;
          tenantId = runtimeResult.tenantId;
        })
        .catch((error) => {
          console.error("[VOICE_REALTIME][TRANSCRIPT_HANDLER_FATAL_ERROR]", {
            callSid,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return;
    }

    if (event.type === "response.done") {
      const completedResponseId = event.response?.id || activeResponseId;

      activeResponseId = null;

      const hadPendingResponse = Boolean(pendingResponseCreate);

      if (hadPendingResponse) {
        flushPendingRealtimeResponse();
        return;
      }

      const completedEndCallGoodbye =
        hangupRequestedByTool &&
        endCallGoodbyeRequested &&
        endCallGoodbyeResponseId &&
        completedResponseId === endCallGoodbyeResponseId;

      if (completedEndCallGoodbye && !pendingResponseCreate && !activeResponseId) {
        hangupRequestedByTool = false;
        endCallGoodbyeRequested = false;
        endCallGoodbyeResponseId = null;
        callEnding = true;

        setTimeout(() => {
          endTwilioCall({
            callSid,
            accountSid: twilioAccountSid,
          }).catch((error) => {
            console.error("[VOICE_REALTIME][TWILIO_HANGUP_ERROR]", {
              callSid,
              accountSid: twilioAccountSid,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 2500);
      }
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

      bookingFlowLoaded = false;
      
      hangupRequestedByTool = false;
      callEnding = false;
      twilioAccountSid = clean((event as any)?.start?.accountSid || "") || null;
      localeLocked = false;
      
      realtimeState = {};
      realtimeTenant = null;
      realtimeCfg = null;
      lastUserTranscript = "";
      lastUserDigits = "";
      lastUserTranscriptSeq = 0;

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

    if (event.event === "dtmf") {
      const digit = clean((event as any)?.dtmf?.digit || "");
      if (digit) {
        lastUserDigits = digit;
      }
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

  twilioSocket.on("close", (code, reason) => {
    console.log("[VOICE_REALTIME][TWILIO_CLOSED]", {
      callSid,
      streamSid,
      code,
      reason: reason?.toString?.() || "",
      openAiReady,
      sessionConfigured,
      callEnding,
      hangupRequestedByTool,
    });

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  twilioSocket.on("error", (error) => {
    console.error("[VOICE_REALTIME][TWILIO_SOCKET_ERROR]", {
      callSid,
      streamSid,
      error: error instanceof Error ? error.message : String(error),
    });

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });
}