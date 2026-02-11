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

  // ✅ NUEVO
  replySource?: string | null;
}) {
  const {
    tenantId,
    canal,
    senderId,
    idiomaDestino,
    lastIntent,
    assistantText,
    replySource,
  } = opts;

  // ✅ BLOCK MEMORY FOR PRICING TURNS
  // (NO afecta métricas: messages/interactions siguen igual; esto solo evita writes a client_memory)
  const intent = String(lastIntent || "").toLowerCase().trim();
  const text = String(assistantText || "");
  const src = String(replySource || "");

  const PRICE_IN_TEXT_RE =
    /(\$\s*\d+(\.\d{1,2})?)|(\bUSD\b)|(\bEUR\b)|(\bMXN\b)|(\bdesde\s*\$?\s*\d+)|(\bstarts?\s*at\s*\$?\s*\d+)|(\bfrom\s*\$?\s*\d+)/i;

  const isPricingTurn =
    intent === "precio" ||
    PRICE_IN_TEXT_RE.test(text) ||
    src.includes("price_") ||
    src.includes("pricing");

  if (isPricingTurn) {
    console.log("🧠 memory: SKIP rememberAfterReply (pricing)", {
      tenantId,
      canal,
      senderId,
      intent,
      replySource: src,
      sample: text.slice(0, 140),
    });
    return;
  }

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
