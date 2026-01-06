// backend/src/lib/memory/rememberFacts.ts
import { getMemoryValue, setMemoryValue } from "../clientMemory";

type Canal = "whatsapp" | "facebook" | "instagram" | "sms" | "voice" | "voz";

export async function rememberFacts(params: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  preferredLang?: "es" | "en";
  lastIntent?: string | null;
  statePagoHumano?: "pago" | "humano" | null;
  businessType?: string | null;
}) {
  const { tenantId, canal, senderId } = params;

  // 🔹 carga facts existentes
  const prevFacts =
    (await getMemoryValue<any>({
      tenantId,
      canal,
      senderId,
      key: "facts",
    })) || {};

  const facts = {
    ...prevFacts,
    preferred_lang: params.preferredLang ?? prevFacts.preferred_lang ?? null,
    last_intent:
      typeof params.lastIntent !== "undefined"
        ? params.lastIntent
        : prevFacts.last_intent ?? null,
    state_pago_humano:
      params.statePagoHumano ?? prevFacts.state_pago_humano ?? null,
    last_seen_at: new Date().toISOString(),
    business_type:
      typeof params.businessType !== "undefined"
        ? params.businessType
        : prevFacts.business_type ?? null,

  };

  // 🔹 guarda facts consolidados
  await setMemoryValue({
    tenantId,
    canal,
    senderId,
    key: "facts",
    value: facts,
  });
}
