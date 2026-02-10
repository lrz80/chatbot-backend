// backend/src/lib/getPromptPorCanal.ts
import { traducirMensaje } from "./traducirMensaje";

type Canal =
  | "whatsapp"
  | "sms"
  | "voice"
  | "facebook"
  | "instagram"
  | "preview"
  | "preview-meta"
  | string;

type Idioma = "es" | "en" | string;

const isMeta = (canal: string) =>
  canal === "facebook" || canal === "instagram" || canal === "preview-meta";

function norm(txt: any) {
  return String(txt ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .trim();
}

export function getPromptPorCanal(canal: Canal, tenant: any, idioma: Idioma = "es"): string {
  const tenantName = tenant?.name || "nuestro negocio";

  if (isMeta(canal)) {
    const pLang = norm(tenant?.meta_config?.[`prompt_meta_${idioma}`] ?? tenant?.[`prompt_meta_${idioma}`]);
    if (pLang) return pLang;

    const p = norm(tenant?.meta_config?.prompt_meta ?? tenant?.prompt_meta);
    if (p) return p;

    throw new Error(`PROMPT_META_MISSING: tenant=${tenantName} canal=${canal} idioma=${idioma}`);
  }

  const pLang = norm(tenant?.[`prompt_${idioma}`]);
  if (pLang) return pLang;

  const p = norm(tenant?.prompt);
  if (p) return p;

  throw new Error(`PROMPT_MISSING: tenant=${tenantName} canal=${canal} idioma=${idioma}`);
}

export async function getBienvenidaPorCanal(
  canal: Canal,
  tenant: any,
  idioma: Idioma = "es"
): Promise<string> {
  const nombre = tenant?.name || "nuestro negocio";

  // ✅ META: meta_configs.bienvenida_meta
  if (isMeta(canal)) {
    const bLang = norm(tenant?.meta_config?.[`bienvenida_meta_${idioma}`] ?? tenant?.[`bienvenida_meta_${idioma}`]);
    if (bLang) return bLang;

    const b = norm(tenant?.meta_config?.bienvenida_meta ?? tenant?.bienvenida_meta);
    if (b) {
      const tenantLang = String(tenant?.idioma || "es").toLowerCase();
      if (tenantLang !== String(idioma).toLowerCase()) {
        try { return await traducirMensaje(b, idioma as any); } catch {}
      }
      return b;
    }

    return generarBienvenidaPorIdioma(nombre, idioma);
  }

  // ✅ WHATSAPP: tenants.mensaje_bienvenida
  const bLang = norm(tenant?.[`mensaje_bienvenida_${idioma}`]);
  if (bLang) return bLang;

  const b = norm(tenant?.mensaje_bienvenida);
  if (b) {
    const tenantLang = String(tenant?.idioma || "es").toLowerCase();
    if (tenantLang !== String(idioma).toLowerCase()) {
      try { return await traducirMensaje(b, idioma as any); } catch {}
    }
    return b;
  }

  return generarBienvenidaPorIdioma(nombre, idioma);
}

function generarBienvenidaPorIdioma(nombre: string, idioma: string): string {
  const mensajes: Record<string, string> = {
    es: `Hola 👋 Soy Amy, bienvenida a ${nombre}. ¿En qué puedo ayudarte hoy?`,
    en: `Hi 👋 I'm Amy, welcome to ${nombre}. How can I help you today?`,
  };
  return mensajes[idioma] || mensajes.es;
}
