import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

// Reusa tu wrapper de modelo (ya lo tienes)
import { answerWithPromptBase } from "../answers/answerWithPromptBase";

type Args = {
  tenantId: string;
  idiomaDestino: Lang;
  canal: Canal;

  // texto base (ej: lista de planes)
  baseText: string;

  // qué “familia” se mostró y qué existe adicional (señales estructurales)
  primary: "plans" | "packages" | "services";
  secondaryAvailable: boolean;

  // opcional: limitar líneas si quieres
  maxLines?: number;
};

export async function naturalizeSecondaryOptionsLine(args: Args): Promise<string> {
  const {
    tenantId,
    idiomaDestino,
    canal,
    baseText,
    primary,
    secondaryAvailable,
    maxLines = 16,
  } = args;

  if (!secondaryAvailable) return baseText;

  // Instrucción genérica (NO copy hardcode por negocio)
  // Nota: evitamos “clases” aquí. Hablamos de “otras opciones/paquetes/bundles” de forma general.
  const rewriteInstruction =
    idiomaDestino === "en"
      ? [
          "TASK: Rewrite the MESSAGE adding exactly ONE short, natural, friendly sentence at the end.",
          "That sentence should mention there are also other options available (e.g., packages/bundles) if the customer wants to see them.",
          "IMPORTANT: Do not ask the user to type any keyword.",
          "IMPORTANT: Do not repeat the list.",
          "IMPORTANT: Do not add extra questions.",
          "Keep the rest unchanged. Return only the final message.",
        ].join("\n")
      : [
          "TAREA: Reescribe el MENSAJE agregando exactamente UNA sola frase corta, natural y amable al final.",
          "Esa frase debe mencionar que también hay otras opciones disponibles (p. ej., paquetes/bundles) si el cliente las quiere ver.",
          "IMPORTANTE: No le pidas que escriba ninguna palabra clave.",
          "IMPORTANTE: No repitas la lista.",
          "IMPORTANTE: No agregues preguntas extra.",
          "Mantén el resto igual. Devuelve solo el mensaje final.",
        ].join("\n");

  const out = await answerWithPromptBase({
    tenantId,
    promptBase: rewriteInstruction,
    userInput: `MESSAGE:\n${String(baseText || "").trim()}\n\nPRIMARY:${primary}`,
    history: [],
    idiomaDestino,
    canal,
    maxLines,
    fallbackText: baseText,
  });

  const text = String(out?.text || "").trim();
  return text || baseText;
}
