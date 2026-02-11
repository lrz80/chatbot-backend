import { rememberFacts } from "./rememberFacts";
import { refreshFactsSummary } from "./refreshFactsSummary";
import type { Canal } from "../../lib/types/canal";

export async function rememberAfterReply(opts: {
  tenantId: string;
  canal: Canal;
  senderId: string;
  idiomaDestino: "es" | "en";
  userText: string;
  assistantText: string;
  lastIntent?: string | null;
}) {
  const {
    tenantId,
    canal,
    senderId,
    idiomaDestino,
    lastIntent,
  } = opts;

  try {
    // ❌ NO guardar transcript en client_memory (turns)
    // ya existe en tabla messages

    await rememberFacts({
      tenantId,
      canal,
      senderId,
      preferredLang: idiomaDestino,
      lastIntent: lastIntent || null,
    });

    await refreshFactsSummary({
      tenantId,
      canal,
      senderId,
      idioma: idiomaDestino,
    });
  } catch (e) {
    console.warn("⚠️ rememberAfterReply failed:", e);
  }
}
