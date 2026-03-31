type BuildDmWriterPromptInput = {
  idiomaDestino: "es" | "en";
  promptBaseMem: string;
  fastpathText: string;
  shouldUseGroundedFrameOnly: boolean;
  shouldForceSalesClosingQuestion: boolean;
  isCatalogDisambiguationReply: boolean;
};

export function buildDmWriterPrompt(
  input: BuildDmWriterPromptInput
): string {
  const isEn = input.idiomaDestino === "en";

  const rules = isEn
    ? [
        "DM_FINAL_RENDER_RULES:",
        "- Use DATOS_ESTRUCTURADOS_DEL_SISTEMA as the source of truth.",
        "- Do not invent prices, names, availability, schedules, locations, links, or options.",
        "- Do not ask the user to reply with a number.",
        "- If clarification is needed, ask only one short question.",
        "- Keep a natural, warm, consultative DM tone.",
        "- Do not alter exact prices, qualifiers, names, bullets, or order when the response policy requires grounded preservation.",
        input.isCatalogDisambiguationReply
          ? "- If the grounded body shows multiple matching options, do NOT act as if the question is already resolved. Do NOT explain what any option includes yet. Only say there is more than one match and ask the user to choose one."
          : input.shouldForceSalesClosingQuestion
          ? "- End with exactly one short consultative sales question."
          : "- Add at most one short consultative closing line only if it helps move the conversation forward.",
        input.shouldUseGroundedFrameOnly
          ? "- Preserve the grounded body exactly and only add brief framing around it when allowed."
          : "- You may rewrite the final message naturally, but only using grounded turn data.",
      ]
    : [
        "REGLAS_RENDER_FINAL_DM:",
        "- Usa DATOS_ESTRUCTURADOS_DEL_SISTEMA como fuente de verdad.",
        "- No inventes precios, nombres, disponibilidad, horarios, ubicaciones, links ni opciones.",
        "- No pidas que el usuario responda con un número.",
        "- Si hace falta aclaración, haz solo una pregunta corta.",
        "- Mantén un tono natural, cálido y consultivo de DM.",
        "- No alteres precios exactos, calificativos, nombres, bullets ni orden cuando la policy exija preservación grounded.",
        input.isCatalogDisambiguationReply
          ? "- Si el cuerpo grounded muestra varias opciones, NO respondas como si la duda ya estuviera resuelta. NO expliques qué incluye ninguna opción todavía. Solo di que hay más de una coincidencia y pide que elija una."
          : input.shouldForceSalesClosingQuestion
          ? "- Cierra con exactamente una pregunta corta, consultiva y vendedora."
          : "- Agrega como máximo un cierre corto y consultivo solo si ayuda a avanzar la conversación.",
        input.shouldUseGroundedFrameOnly
          ? "- Preserva el cuerpo grounded exacto y solo agrega framing breve alrededor cuando esté permitido."
          : "- Puedes redactar el mensaje final de forma natural, pero solo usando los datos grounded del turno.",
      ];

  return [
    input.promptBaseMem,
    "",
    "DATOS_ESTRUCTURADOS_DEL_SISTEMA:",
    input.fastpathText,
    "",
    rules.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}