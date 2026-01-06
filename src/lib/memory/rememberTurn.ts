import { setMemoryValue, getMemoryValue } from "../clientMemory";

type Canal =
  | "whatsapp"
  | "sms"
  | "email"
  | "voice"
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
function normalizeCanal(canal: Canal): "whatsapp" | "sms" | "email" | "voice" | "meta" | "preview" {
  if (canal === "facebook" || canal === "instagram") return "meta";
  if (canal === "voz") return "voice";
  return canal as any;
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
  assistantText?: string;   // ✅ ahora es opcional
  keepLast?: number;        // default 8
}) {
  const {
    tenantId,
    canal,
    senderId,
    userText,
  } = params;

  const assistantText = (params.assistantText || "").trim();
  const keepLast = params.keepLast ?? 8;
  const normalizedCanal = normalizeCanal(canal);

  // 🚫 Si no hay texto del usuario, no guardes nada
  if (!userText || !userText.trim()) {
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
    // ✅ si no hubo respuesta del bot, igual guardamos el turno con assistant vacío
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
