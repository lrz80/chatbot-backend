// src/lib/voice/runtime/resolveFreeConversationBookingIntent.ts

export type FreeConversationBookingIntent =
  | "start_booking"
  | "free_conversation";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isFreeConversationBookingIntent(
  value: unknown
): value is FreeConversationBookingIntent {
  return (
    value === "start_booking" ||
    value === "free_conversation"
  );
}

export async function resolveFreeConversationBookingIntent(params: {
  callerTranscript: string;
  previousAssistantTranscript?: string | null;
  locale?: string | null;
}): Promise<FreeConversationBookingIntent> {
  const callerTranscript = clean(params.callerTranscript);
  const previousAssistantTranscript = clean(
    params.previousAssistantTranscript
  );
  const locale = clean(params.locale);

  if (!callerTranscript) {
    return "free_conversation";
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "[VOICE_REALTIME][FREE_BOOKING_INTENT_NO_OPENAI_KEY]"
    );

    return "free_conversation";
  }

  try {
    const { default: OpenAI } = await import("openai");

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const completion =
      await openai.chat.completions.create({
        model:
          clean(
            process.env
              .OPENAI_FREE_BOOKING_INTENT_MODEL
          ) || "gpt-4o-mini",

        temperature: 0,
        max_tokens: 60,

        response_format: {
          type: "json_object",
        },

        messages: [
          {
            role: "system",
            content: [
              "Classify whether the caller currently intends to start an appointment, reservation, estimate, consultation, visit, or other tenant-configured booking flow.",
              "",
              "Use both the caller's latest message and the immediately previous assistant message.",
              "",
              "Return exactly one JSON object:",
              '{"decision":"start_booking"}',
              '{"decision":"free_conversation"}',
              "",
              "Classification rules:",
              "- start_booking: the caller clearly wants to book, schedule, reserve, arrange a visit, request scheduling, check appointment availability for the purpose of scheduling, or clearly accepts the assistant's immediately previous offer to schedule.",
              "- free_conversation: the caller is only asking for information, asking a business question, discussing a service without requesting scheduling, rejecting scheduling, changing the subject, or giving an ambiguous response that does not clearly establish booking intent.",
              "",
              "Context matters.",
              "A short affirmative answer may mean start_booking only when the immediately previous assistant message clearly offered or asked to start scheduling.",
              "Do not interpret an affirmative answer as booking intent when it answers an unrelated question.",
              "",
              "The business type is unknown and may vary by tenant.",
              "Do not assume salon, medical, restaurant, contractor, or any other specific business type.",
              "Booking terminology may include appointments, reservations, estimates, consultations, visits, inspections, or other scheduling concepts depending on the tenant.",
              "",
              "Understand the caller and assistant messages in any language.",
              "Do not depend on fixed keywords or a specific language.",
              "When uncertain, choose free_conversation.",
              "Return JSON only.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              callerLocale: locale || null,
              previousAssistantMessage:
                previousAssistantTranscript || null,
              callerMessage: callerTranscript,
            }),
          },
        ],
      });

    const content = clean(
      completion.choices[0]?.message?.content
    );

    if (!content) {
      return "free_conversation";
    }

    const parsed = JSON.parse(content);
    const decision = clean(parsed?.decision);

    return isFreeConversationBookingIntent(decision)
      ? decision
      : "free_conversation";
  } catch (error) {
    console.error(
      "[VOICE_REALTIME][FREE_BOOKING_INTENT_ERROR]",
      {
        callerTranscript,
        previousAssistantTranscript,
        locale,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );

    /**
     * Safe fallback:
     * never start a booking when semantic intent
     * could not be resolved reliably.
     */
    return "free_conversation";
  }
}