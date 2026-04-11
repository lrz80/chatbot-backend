import OpenAI from "openai";

export type BinaryTurnResolution = "yes" | "no" | "unknown";

type ResolveBinaryTurnSignalArgs = {
  userInput: string;
  idiomaDestino: string;
  convoCtx: any;
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function hasActiveBinaryAwaiting(convoCtx: any): boolean {
  return Boolean(
    convoCtx?.awaiting_yesno === true ||
      convoCtx?.awaiting_yes_no_action?.kind ||
      convoCtx?.pending_cta?.kind
  );
}

function buildQuestionContext(convoCtx: any): string {
  const pendingCta = convoCtx?.pending_cta ?? null;
  const awaitingAction = convoCtx?.awaiting_yes_no_action ?? null;
  const lastAssistantText = String(convoCtx?.last_assistant_text || "").trim();

  const ctx = {
    pendingCta: pendingCta
      ? {
          kind: pendingCta.kind ?? null,
          ctaType: pendingCta.ctaType ?? pendingCta.type ?? null,
          serviceName: pendingCta.serviceName ?? null,
          variantName: pendingCta.variantName ?? null,
          originalIntent: pendingCta.originalIntent ?? null,
        }
      : null,
    awaitingAction: awaitingAction
      ? {
          kind: awaitingAction.kind ?? null,
          ctaType: awaitingAction.ctaType ?? awaitingAction.type ?? null,
        }
      : null,
    lastAssistantText: lastAssistantText || null,
  };

  return JSON.stringify(ctx);
}

export async function resolveBinaryTurnSignal(
  args: ResolveBinaryTurnSignalArgs
): Promise<BinaryTurnResolution> {
  const rawInput = String(args.userInput || "").trim();

  if (!rawInput) {
    return "unknown";
  }

  if (!hasActiveBinaryAwaiting(args.convoCtx)) {
    return "unknown";
  }

  try {
    const questionContext = buildQuestionContext(args.convoCtx);

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Clasifica la respuesta del usuario frente a una pregunta binaria pendiente. " +
            'Debes responder JSON estricto con una sola clave: {"resolution":"yes"|"no"|"unknown"}. ' +
            "No inventes. Si el mensaje no expresa aceptación o rechazo claros, devuelve unknown.",
        },
        {
          role: "user",
          content:
            `Idioma del turno: ${args.idiomaDestino}\n` +
            `Contexto de la pregunta pendiente: ${questionContext}\n` +
            `Mensaje del usuario: ${rawInput}`,
        },
      ],
      response_format: {
        type: "json_object",
      },
    });

    const content = String(
      response.choices?.[0]?.message?.content || ""
    ).trim();

    if (!content) {
      return "unknown";
    }

    const parsed = JSON.parse(content) as {
      resolution?: string;
    };

    const resolution = String(parsed?.resolution || "")
      .trim()
      .toLowerCase();

    if (resolution === "yes" || resolution === "no") {
      return resolution;
    }

    return "unknown";
  } catch (error: any) {
    console.warn("[BINARY_TURN_SIGNAL] failed:", error?.message || error);
    return "unknown";
  }
}