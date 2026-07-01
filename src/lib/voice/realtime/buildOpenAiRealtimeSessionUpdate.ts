// src/lib/voice/realtime/buildOpenAiRealtimeSessionUpdate.ts

type BuildOpenAiRealtimeSessionUpdateParams = {
  instructions: string;
  voice: string;
  model: string;

  /**
   * True only when the tenant has at least one configured useful link
   * that can be sent by SMS.
   *
   * This must come from tenant configuration / backend state.
   * Do not hardcode it per business.
   */
  canSendUsefulLinkSms?: boolean;
};

function numberFromEnv(params: {
  key: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = process.env[params.key];
  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    return params.fallback;
  }

  return Math.min(params.max, Math.max(params.min, parsed));
}

function booleanFromEnv(params: {
  key: string;
  fallback: boolean;
}): boolean {
  const raw = String(process.env[params.key] ?? "").trim().toLowerCase();

  if (!raw) return params.fallback;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;

  return params.fallback;
}

function buildRealtimeTurnDetection(): Record<string, unknown> {
  return {
    type: "server_vad",

    /**
     * Higher = less sensitive.
     * Speakerphone/echo needs a stricter threshold than headphones.
     */
    threshold: numberFromEnv({
      key: "OPENAI_REALTIME_VAD_THRESHOLD",
      fallback: 0.9,
      min: 0.5,
      max: 0.98,
    }),

    /**
     * Keeps a small amount of audio before speech starts,
     * so words are not clipped when the caller really speaks.
     */
    prefix_padding_ms: numberFromEnv({
      key: "OPENAI_REALTIME_VAD_PREFIX_PADDING_MS",
      fallback: 450,
      min: 100,
      max: 1000,
    }),

    /**
     * Requires longer silence before considering the user turn complete.
     * This reduces false turns from short speaker noise.
     */
    silence_duration_ms: numberFromEnv({
      key: "OPENAI_REALTIME_VAD_SILENCE_DURATION_MS",
      fallback: 1300,
      min: 500,
      max: 2500,
    }),

    interrupt_response: false,

    /**
     * Keep this false because your server already controls when responses
     * are created through requestRealtimeResponse().
     */
    create_response: booleanFromEnv({
      key: "OPENAI_REALTIME_VAD_CREATE_RESPONSE",
      fallback: false,
    }),
  };
}

function buildUsefulLinkSmsInstructions(params: {
  canSendUsefulLinkSms: boolean;
}): string[] {
  if (!params.canSendUsefulLinkSms) {
    return [
      "- Do not offer to send links by SMS because this tenant has no useful links configured.",
      "- Do not call send_useful_link_sms. That capability is not available for this tenant.",
      "- If the caller asks for a link by SMS, explain briefly that you can provide the available business information verbally.",
      "- If automatic booking cannot be completed and the tool result says fallback_action is SEND_BOOKING_LINK, do not mention the booking provider, API, subscription, integration, or technical reason to the caller.",
      "- In that fallback case, explain naturally that the reservation cannot be completed automatically right now and offer to help with any other available business information.",
    ];
  }

  return [
    "- You may offer to send a useful configured link by SMS when the caller asks for it or clearly agrees to receive it.",
    "- Useful links can include location, booking, payment, website, social media, menu, quote, or any other tenant-configured link.",
    "- Call send_useful_link_sms only after the caller agrees to receive the link by SMS.",
    "- When calling send_useful_link_sms, set link_types based on the caller's request.",
    "- For location or address requests, use link_types like ['location', 'ubicacion', 'maps', 'google_maps'].",
    "- For booking or appointment requests, use link_types like ['booking', 'square_booking', 'appointments'].",
    "- For payment requests, use link_types like ['payment', 'pay', 'pagar'].",
    "- Never invent useful links. The server must send useful links from tenant-configured links only.",
    "- If send_useful_link_sms succeeds, briefly confirm that the link was sent and ask if they need anything else.",
    "- If automatic booking cannot be completed and the tool result says fallback_action is SEND_BOOKING_LINK, do not mention the booking provider, API, subscription, integration, or technical reason to the caller.",
    "- In that fallback case, explain naturally that the reservation cannot be completed automatically right now and ask whether the caller wants the official booking link by SMS.",
    "- Do not call end_call in the same turn after send_useful_link_sms.",
    "- Never call end_call immediately after create_appointment, send_booking_sms, or send_useful_link_sms unless the caller explicitly ends the conversation in a later caller turn.",
  ];
}

function buildRealtimeTools(params: {
  canSendUsefulLinkSms: boolean;
}): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [
    {
      type: "function",
      name: "get_booking_flow",
      description:
        "Get the tenant-configured booking flow and current canonical booking state before or during appointment booking. Follow the configured step order and do not skip required steps.",
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
        "Create a real appointment only after the tenant-configured booking flow is complete and the server-side booking state confirms the caller has accepted the final confirmation. Do not pass tenant-specific fields. The server must create the appointment from the validated canonical booking state, not from model-inferred arguments.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },
    {
      type: "function",
      name: "send_booking_sms",
      description:
        "Send the confirmed booking details by SMS using the server-side canonical booking state. Use this only after the caller accepts the SMS offer. Do not pass phone number, message, tenant fields, or booking fields. The server builds and sends the SMS from validated booking state.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
    },
  ];

  if (params.canSendUsefulLinkSms) {
    tools.push({
      type: "function",
      name: "send_useful_link_sms",
      description:
        "Send a tenant-configured useful link by SMS to the caller, such as location, booking, payment, website, menu, social media, or another configured link. Use this only after the caller agrees to receive the link.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          link_types: {
            type: "array",
            items: {
              type: "string",
            },
            description:
              "Useful link type priority based on the caller request. Examples: location/address/maps -> ['location', 'ubicacion', 'maps', 'google_maps']; booking/appointment -> ['booking', 'square_booking', 'appointments']; payment/pay -> ['payment', 'pay', 'pagar'].",
          },
        },
        required: [],
      },
    });
  }

  tools.push({
    type: "function",
    name: "end_call",
    description:
      "Request to end the call only after the caller clearly confirms they do not need anything else, says goodbye, or asks to end the call. Do not use immediately after sending an SMS, useful link, booking link, or appointment fallback message.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  });

  return tools;
}

export function buildOpenAiRealtimeSessionUpdate(
  params: BuildOpenAiRealtimeSessionUpdateParams
): Record<string, unknown> {
  const canSendUsefulLinkSms = params.canSendUsefulLinkSms === true;

  console.log("[VOICE_REALTIME][SESSION_CAPABILITIES]", {
    canSendUsefulLinkSms,
  });

  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: params.model,
      instructions: [
        params.instructions,
        "",
        "Realtime voice behavior:",
        "- Speak naturally, warmly, and conversationally.",
        "- Never sound like an IVR, script reader, form reader, or answering machine.",
        "- Preserve the caller's active language.",
        "- Keep each spoken response short because this is a phone call.",
        "- Ask only one question at a time.",
        "- Do not skip required booking steps.",
        "- Do not invent completed slots.",
        "- Do not store booking answers mentally. The server-side booking state is the only source of truth.",
        "- Do not call submit_booking_step. The server processes accepted caller transcripts and advances booking steps automatically.",
        "- When the server provides a booking prompt, speak that prompt naturally and wait for the caller's answer.",
        "- If the caller answers a booking question, wait for the server to process the accepted transcript. Do not call a booking-step submission tool.",
        "- Do not pre-fill future booking steps.",
        "- Never call a tool named send_sms. That tool does not exist.",
        "- Call send_booking_sms only after the server has accepted the configured SMS consent step and no booking step is pending.",
        "- Never invent SMS text or phone numbers. The server sends booking SMS from canonical booking state.",
        ...buildUsefulLinkSmsInstructions({
          canSendUsefulLinkSms,
        }),
        "- Only call end_call after the caller clearly says they do not need anything else, says goodbye, or asks to end the call.",
      ].join("\n"),
      audio: {
        input: {
          format: {
            type: "audio/pcmu",
          },
          transcription: {
            model: "gpt-4o-mini-transcribe",
          },
          turn_detection: buildRealtimeTurnDetection(),
        },
        output: {
          format: {
            type: "audio/pcmu",
          },
          voice: params.voice,
        },
      },
      tools: buildRealtimeTools({
        canSendUsefulLinkSms,
      }),
      tool_choice: "auto",
    },
  };
}