import { rememberTurn } from "./rememberTurn";
import { rememberFacts } from "./rememberFacts";
import { refreshFactsSummary } from "./refreshFactsSummary";
import type { Canal } from "../../lib/types/canal";

export async function rememberAfterReply(opts: {
  tenantId: string;
  canal: Canal;              // "whatsapp" | "facebook" | "instagram" | etc.
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
    userText,
    assistantText,
    lastIntent,
  } = opts;

  try {
    await rememberTurn({
      tenantId,
      canal,
      senderId,
      userText,
      assistantText,
    });

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
