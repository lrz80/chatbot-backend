// backend/src/lib/memory/rememberTurn.ts
import { setMemoryValue, getMemoryValue } from "../clientMemory";

type Canal = "whatsapp" | "facebook" | "instagram" | "sms" | "voice";

const clamp = (s: string, max = 700) => {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
};

// Guarda un “historial corto” de N turns en una sola key: conversation_buffer
export async function rememberTurn(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  userText: string;
  assistantText: string;
  keepLast?: number; // default 8
}) {
  const { tenantId, canal, senderId, userText, assistantText } = params;
  const keepLast = params.keepLast ?? 8;

  const existing = await getMemoryValue<any[]>({
    tenantId,
    canal,
    senderId,
    key: "conversation_buffer",
  });

  const buffer = Array.isArray(existing) ? existing : [];

  buffer.push({
    at: new Date().toISOString(),
    u: clamp(userText, 500),
    a: clamp(assistantText, 700),
  });

  const sliced = buffer.slice(-keepLast);

  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "conversation_buffer",
    value: sliced,
  });
}
