import OpenAI from "openai";
import { getMemoryValue, setMemoryValue } from "../clientMemory";

export async function refreshFactsSummary(opts: {
  tenantId: string;
  canal: string;
  senderId: string;
  idioma: "es" | "en";
  force?: boolean;
  maxTurnsToUse?: number;        // default 12
  refreshEveryTurns?: number;    // default 6
}) {
  const {
    tenantId,
    canal,
    senderId,
    idioma,
    force = false,
    maxTurnsToUse = 12,
    refreshEveryTurns = 6,
  } = opts;

  // 1) meta
  const meta = await getMemoryValue<any>({
    tenantId,
    canal,
    senderId,
    key: "summary_meta",
  });

  const turnsSince = Number(meta?.turnsSinceRefresh ?? 0);

  // 2) carga summary previo (para decidir si refrescar)
  const prevSummaryRaw = await getMemoryValue<any>({
    tenantId,
    canal,
    senderId,
    key: "facts_summary",
  });

  const prevSummary =
    typeof prevSummaryRaw === "string"
      ? prevSummaryRaw
      : (prevSummaryRaw &&
          typeof prevSummaryRaw === "object" &&
          typeof prevSummaryRaw.text === "string")
        ? prevSummaryRaw.text
        : "";

  const hasPrev = Boolean(prevSummary && prevSummary.trim());

  // ✅ throttling correcto:
  // - Si NO hay summary previo: generamos uno (primer refresh)
  // - Si ya hay summary: solo refrescar si llegaron N turnos (o force)
  if (!force) {
    if (hasPrev && turnsSince < refreshEveryTurns) {
      return;
    }
  }

  // 3) carga facts + turns
  const facts = await getMemoryValue<any>({
    tenantId,
    canal,
    senderId,
    key: "facts",
  });

  const turns = await getMemoryValue<any[]>({
    tenantId,
    canal,
    senderId,
    key: "turns",
  });

  const turnArr = Array.isArray(turns) ? turns : [];
  const lastTurns = turnArr.slice(-maxTurnsToUse);

  // Si no hay material real, no inventes
  if (!lastTurns.length && !facts) return;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system =
    idioma === "en"
      ? [
          "You are a memory summarizer for a business messaging assistant.",
          "Write a compact rolling memory for this specific customer.",
          "Rules:",
          "- Never invent facts. If unknown, omit.",
          "- Prefer stable facts: name, business type, preferences, constraints, stage (payment/booking), language.",
          "- Output ONLY plain text, max 10 lines.",
          "- No bullet characters, no markdown.",
          "- Do not write placeholders like 'unknown', 'not specified', 'not provided'. Omit instead.",
          "- If there are no useful facts, return an empty string (no text).",
        ].join("\n")
      : [
          "Eres un resumidor de memoria para un asistente de mensajería de negocios.",
          "Escribe una memoria compacta y continua de ESTE cliente.",
          "Reglas:",
          "- No inventes hechos. Si no se sabe, omítelo.",
          "- Prioriza hechos estables: nombre, tipo de negocio, preferencias, restricciones, etapa (pago/cita), idioma.",
          "- Salida SOLO texto plano, máximo 10 líneas.",
          "- Sin viñetas, sin markdown.",
          "- No escribas frases como 'no especificado', 'desconocido', 'no se sabe'. Simplemente omite ese dato.",
          "- Si NO hay ningún hecho útil, responde con una cadena vacía (sin texto).",
        ].join("\n");

  const user = [
    `SUMMARY_ANTERIOR:\n${prevSummary || "(vacío)"}`,
    "",
    `FACTS_JSON:\n${JSON.stringify(facts || {}, null, 2)}`,
    "",
    "ULTIMOS_TURNOS:",
    ...lastTurns.map((t, i) => {
      const u = String(t?.u || "").slice(0, 800);
      const a = String(t?.a || "").slice(0, 800);
      return `T${i + 1} U: ${u}\nT${i + 1} A: ${a}`;
    }),
    "",
    idioma === "en"
      ? "Return the updated rolling memory now."
      : "Devuelve ahora la memoria actualizada.",
  ].join("\n");

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 220,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = (completion.choices[0]?.message?.content || "").trim();
  if (!text) return;

  // 4) guarda como STRING en facts_summary
  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "facts_summary",
    value: text,
  });

  // 5) reset counter (y guarda timestamps)
  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "summary_meta",
    value: {
      ...(meta && typeof meta === "object" ? meta : {}),
      turnsSinceRefresh: 0,
      lastRefreshAt: new Date().toISOString(),
    },
  });
}
