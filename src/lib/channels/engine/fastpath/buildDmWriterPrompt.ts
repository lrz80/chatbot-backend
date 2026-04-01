// src/lib/channels/engine/fastpath/buildDmWriterPrompt.ts

type BuildDmWriterPromptInput = {
  idiomaDestino: "es" | "en";
  promptBaseMem: string;
  fastpathText: string;
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
        "- Write only with grounded turn data already provided by the system.",
      ]
    : [
        "REGLAS_RENDER_FINAL_DM:",
        "- Usa DATOS_ESTRUCTURADOS_DEL_SISTEMA como fuente de verdad.",
        "- No inventes precios, nombres, disponibilidad, horarios, ubicaciones, links ni opciones.",
        "- No pidas que el usuario responda con un número.",
        "- Si hace falta aclaración, haz solo una pregunta corta.",
        "- Mantén un tono natural, cálido y consultivo de DM.",
        "- Redacta solo con los datos grounded del turno ya provistos por el sistema.",
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