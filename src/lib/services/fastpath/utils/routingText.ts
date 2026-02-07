// backend/src/lib/services/fastpath/utils/routingText.ts
import { traducirMensaje } from "../../../traducirMensaje";

type Lang = "es" | "en";

export async function toCanonicalEsForRouting(text: string, lang: Lang) {
  const t = String(text || "").trim();
  if (!t) return t;
  if (lang === "es") return t;

  try {
    const es = await traducirMensaje(t, "es");
    return String(es || t).trim() || t;
  } catch {
    return t;
  }
}
