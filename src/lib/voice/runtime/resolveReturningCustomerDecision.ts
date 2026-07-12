//src/lib/voice/runtime/resolveReturningCustomerDecision.ts
export type ReturningCustomerDecision =
  | "repeat_previous_service"
  | "start_new_booking"
  | "free_conversation";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isReturningCustomerDecision(
  value: unknown
): value is ReturningCustomerDecision {
  return (
    value === "repeat_previous_service" ||
    value === "start_new_booking" ||
    value === "free_conversation"
  );
}

export async function resolveReturningCustomerDecision(params: {
  transcript: string;
  previousService: string;
  locale?: string | null;
}): Promise<ReturningCustomerDecision> {
  const transcript = clean(params.transcript);
  const previousService = clean(params.previousService);
  const locale = clean(params.locale);

  if (!transcript || !previousService) {
    return "free_conversation";
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn(
      "[VOICE_REALTIME][RETURNING_CUSTOMER_DECISION_NO_OPENAI_KEY]"
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
              .OPENAI_RETURNING_CUSTOMER_DECISION_MODEL
          ) || "gpt-4o-mini",

        temperature: 0,
        max_tokens: 80,

        response_format: {
          type: "json_object",
        },

        messages: [
          {
            role: "system",
            content: [
              "Classify the caller's response to a personalized phone greeting.",
              "",
              "The caller was asked whether they want to book the same service as their previous reservation.",
              "",
              "Return exactly one JSON object:",
              '{"decision":"repeat_previous_service"}',
              '{"decision":"start_new_booking"}',
              '{"decision":"free_conversation"}',
              "",
              "Classification rules:",
              "- repeat_previous_service: the caller clearly accepts booking the previously mentioned service.",
              "- start_new_booking: the caller clearly wants an appointment or reservation, but rejects the previous service or wants a different service.",
              "- free_conversation: the caller asks a question, changes the topic, gives an unclear response, or does not clearly intend to start a booking.",
              "",
              "Understand the caller in any language.",
              "Do not assume booking intent from an ambiguous answer.",
              "Return JSON only.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              callerLocale: locale || null,
              previousService,
              callerResponse: transcript,
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

    return isReturningCustomerDecision(decision)
      ? decision
      : "free_conversation";
  } catch (error) {
    console.error(
      "[VOICE_REALTIME][RETURNING_CUSTOMER_DECISION_ERROR]",
      {
        transcript,
        previousService,
        locale,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );

    /**
     * El fallback más seguro es no iniciar reservas.
     */
    return "free_conversation";
  }
}