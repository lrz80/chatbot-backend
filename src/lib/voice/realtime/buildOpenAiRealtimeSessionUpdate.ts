// src/lib/voice/realtime/buildOpenAiRealtimeSessionUpdate.ts
import { USE_CALLER_PHONE_TOKEN } from "./bookingStep/resolvers/resolveRealtimePhoneValue";

type BuildOpenAiRealtimeSessionUpdateParams = {
  instructions: string;
  voice: string;
  model: string;
};

export function buildOpenAiRealtimeSessionUpdate(
  params: BuildOpenAiRealtimeSessionUpdateParams
): Record<string, unknown> {
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
        "- When a booking step provides a prompt, use it only as the meaning of the question, not as a phrase to read literally.",
        "- Rephrase booking questions in a human way while preserving the exact slot being requested.",
        "- Do not skip required booking steps.",
        "- Do not invent completed slots.",
        "- Keep each spoken response short because this is a phone call.",
        "- Ask only one booking question at a time.",
        "- If the caller already answered the current slot, submit it with the proper tool instead of asking again.",
        "- Preserve the caller's active language.",
        "- Never call a tool named send_sms. That tool does not exist.",
        "- If the current pending booking step asks whether the caller wants booking details by SMS, submit that configured booking step with submit_booking_step using the caller's latest answer. Do not call send_booking_sms for the SMS offer step.",
        "- Call send_booking_sms only after the server has accepted the configured SMS consent step and no booking step is pending.",
        "- Never invent SMS text or phone numbers. The server sends booking SMS from canonical booking state.",
        "- If automatic booking cannot be completed and the tool result says fallback_action is SEND_BOOKING_LINK, do not mention the booking provider, API, subscription, integration, or technical reason to the caller.",
        "- In that fallback case, explain naturally that the reservation cannot be completed automatically right now and ask whether the caller wants the official booking link by SMS.",
        "- If the caller agrees to receive the official booking link, call send_useful_link_sms with link_types ['booking', 'square_booking', 'appointments'].",
        "- Never invent useful links. The server must send useful links from tenant-configured links only.",
        "- Do not call end_call while a booking-link SMS fallback question is waiting for the caller answer.",
        "- Never submit a booking step using inferred information that the caller did not clearly say in the latest user turn.",
        "- For submit_booking_step, the value must come from the caller's latest answer to the current question, not from assumptions or earlier context.",
        "- If the latest transcript does not directly answer the current booking question, ask the current question again naturally instead of submitting the step.",
        "- Do not pre-fill future booking steps.",
        "- Never call submit_booking_step twice from the same caller transcript.",
        "- After send_useful_link_sms succeeds, tell the caller the official link was sent and ask if they need anything else.",
        "- Do not call end_call in the same turn after send_useful_link_sms.",
        "- Only call end_call after the caller clearly says they do not need anything else, says goodbye, or asks to end the call.",
        "- Never call end_call immediately after create_appointment, send_booking_sms, or send_useful_link_sms unless the caller explicitly ends the conversation in a later caller turn.",
        `- For a phone-number booking step, if the caller clearly confirms they want to use the current calling number, call submit_booking_step with value "${USE_CALLER_PHONE_TOKEN}".`,
        "- For a phone-number booking step, if the caller provides a different phone number, submit only that phone number as value.",
        "- For a phone-number booking step, never submit a name, service, date, staff member, yes/no word, or unrelated transcript as the value.",
      ].join("\n"),
      audio: {
        input: {
          format: {
            type: "audio/pcmu",
          },
          transcription: {
            model: "gpt-4o-mini-transcribe",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.82,
            prefix_padding_ms: 300,
            silence_duration_ms: 1100,
            interrupt_response: false,
            create_response: true,
          },
        },
        output: {
          format: {
            type: "audio/pcmu",
          },
          voice: params.voice,
        },
      },
      tools: [
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
          name: "submit_booking_step",
          description: [
            "Submit the caller answer for the current tenant-configured booking step.",
            "Use this to advance the booking flow one canonical step at a time.",
            "Do not skip steps.",
            "Do not invent slot completion.",
            `For phone-number steps, use value "${USE_CALLER_PHONE_TOKEN}" only when the caller clearly confirms using the current calling number.`,
            "For phone-number steps, if the caller provides a different phone number, submit only the phone number.",
          ].join(" "),
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              step_key: {
                type: "string",
                description: "The canonical current booking step key.",
              },
              value: {
                type: "string",
                description: [
                  "The caller answer for the current booking step.",
                  `For phone-number steps, use "${USE_CALLER_PHONE_TOKEN}" only when the caller confirms using the current calling number.`,
                  "Otherwise submit the explicit value said by the caller.",
                ].join(" "),
              },
            },
            required: ["step_key", "value"],
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
        {
          type: "function",
          name: "send_useful_link_sms",
          description:
            "Send an official useful link by SMS to the caller, such as a booking link, when automatic booking cannot be completed. Use this only after the caller agrees to receive the link.",
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
                  "Useful link type priority. For booking fallback use ['booking', 'square_booking', 'appointments'].",
              },
            },
            required: [],
          },
        },
        {
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
        },
      ],
      tool_choice: "auto",
    },
  };
}