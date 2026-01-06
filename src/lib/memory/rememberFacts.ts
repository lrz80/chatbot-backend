// backend/src/lib/memory/rememberFacts.ts
import { setMemoryValue } from "../clientMemory";

type Canal = "whatsapp" | "facebook" | "instagram" | "sms" | "voice";

export async function rememberFacts(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  preferredLang?: "es" | "en";
  lastIntent?: string | null;
  statePagoHumano?: "pago" | "humano" | null;
}) {
  const { tenantId, canal, senderId } = params;

  // Siempre actualiza last_seen_at
  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "last_seen_at",
    value: new Date().toISOString(),
  });

  if (params.preferredLang) {
    await setMemoryValue({
      tenantId,
      canal,
      senderId,
      key: "preferred_lang",
      value: params.preferredLang,
    });
  }

  if (typeof params.lastIntent !== "undefined") {
    await setMemoryValue({
      tenantId,
      canal,
      senderId,
      key: "last_intent",
      value: params.lastIntent,
    });
  }

  if (params.statePagoHumano) {
    await setMemoryValue({
      tenantId,
      canal,
      senderId,
      key: "state_pago_humano",
      value: params.statePagoHumano,
    });
  }
}
