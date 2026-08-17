//src/lib/appointments/booking/runtime/classifySharedBookingStepAnswer.ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

export type SharedBookingStepAnswerDecision =
  | {
      answersCurrentStep: true;
    }
  | {
      answersCurrentStep: false;
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function classifySharedBookingStepAnswer(
  params: {
    userInput: string;
    stepKey?: string | null;
    slot?: string | null;
    expectedType?: string | null;
    prompt?: string | null;
  }
): Promise<SharedBookingStepAnswerDecision> {
  const userInput = clean(params.userInput);
  const prompt = clean(params.prompt);

  if (!userInput) {
    return {
      answersCurrentStep: false,
    };
  }

  /*
   * Si por alguna razón no tenemos contexto suficiente
   * del step, no bloqueamos el runtime existente.
   */
  if (!prompt) {
    return {
      answersCurrentStep: true,
    };
  }

  try {
    const response =
      await openai.chat.completions.create({
        model:
          process.env.BOOKING_STEP_GATE_MODEL?.trim() ||
          "gpt-4o-mini",

        messages: [
          {
            role: "system",
            content: [
              "You are an internal booking turn classifier.",
              "Never answer the customer.",
              "Determine whether the customer's latest message directly answers the CURRENT booking question.",
              "The customer may speak any language.",
              "Judge meaning, not keywords.",
              "Do not require the answer to be in the same language as the configured prompt.",
              "A greeting, unrelated business question, request for more information, price question, conversation interruption, or other off-topic message does NOT answer the current booking question.",
              "An answer may contain brief conversational filler and still count if it clearly supplies the requested value.",
              "Do not infer a missing value.",
              "Return JSON only.",
              'Schema: {"answers_current_step":true}',
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              current_step: {
                step_key:
                  clean(params.stepKey) || null,
                slot:
                  clean(params.slot) || null,
                expected_type:
                  clean(params.expectedType) || null,
                prompt,
              },
              latest_customer_message:
                userInput,
            }),
          },
        ],

        response_format: {
          type: "json_object",
        },
      });

    const content =
      response.choices[0]?.message?.content?.trim();

    if (!content) {
      return {
        answersCurrentStep: true,
      };
    }

    const parsed = JSON.parse(content);

    return {
      answersCurrentStep:
        parsed?.answers_current_step === true,
    };
  } catch (error) {
    console.warn(
      "[SHARED_BOOKING][STEP_ANSWER_CLASSIFIER_FAILED]",
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );

    /*
     * Fail-open para no romper bookings si
     * el clasificador no está disponible.
     */
    return {
      answersCurrentStep: true,
    };
  }
}