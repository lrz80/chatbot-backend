import { setMemoryValue, getMemoryValue } from "../clientMemory";

type Canal =
  | "whatsapp"
  | "sms"
  | "email"
  | "voz"
  | "meta"
  | "facebook"
  | "instagram"
  | "preview";

// --------------------------------------------------
// Helpers
// --------------------------------------------------

const clamp = (s: string, max = 700) => {
  const t = (s || "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
};

// Normaliza canal para evitar memorias partidas
function normalizeCanal(canal: Canal): Canal {
  if (canal === "facebook" || canal === "instagram") return "meta";
  return canal;
}

// --------------------------------------------------
// Guarda un “historial corto” de N turns
// key: conversation_buffer
// --------------------------------------------------

export async function rememberTurn(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  userText: string;
  assistantText: string;
  keepLast?: number; // default 8
}) {
  const {
    tenantId,
    canal,
    senderId,
    userText,
    assistantText,
  } = params;

  const keepLast = params.keepLast ?? 8;
  const normalizedCanal = normalizeCanal(canal);

  // 🚫 No guardamos turnos sin respuesta del asistente
  if (!assistantText || !assistantText.trim()) {
    return;
  }

  const existing = await getMemoryValue<any[]>({
    tenantId,
    canal: normalizedCanal,
    senderId,
    key: "conversation_buffer",
  });

  const buffer = Array.isArray(existing) ? existing : [];

  buffer.push({
    at: new Date().toISOString(),
    user: clamp(userText, 500),
    assistant: clamp(assistantText, 700),
  });

  const sliced = buffer.slice(-keepLast);

  await setMemoryValue({
    tenantId,
    canal: normalizedCanal,
    senderId,
    key: "conversation_buffer",
    value: sliced,
  });
}
