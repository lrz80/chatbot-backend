// src/lib/getPromptPorCanal.ts

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

/**
 * DB-only:
 * - Prioridad: prompt por idioma (si existe)
 * - Luego: prompt base
 * - Si no hay prompt -> lanza error (para que NO responda genérico)
 */
export function getPromptPorCanal(canal: Canal, tenant: any, idioma: Idioma = "es"): string {
  const tenantName = tenant?.name || "nuestro negocio";

  if (isMeta(canal)) {
    const pLang = norm(tenant?.[`prompt_meta_${idioma}`] ?? tenant?.meta_config?.[`prompt_meta_${idioma}`]);
    if (pLang) return pLang;

    const p = norm(tenant?.prompt_meta ?? tenant?.meta_config?.prompt_meta);
    if (p) return p;

    throw new Error(`PROMPT_META_MISSING: tenant=${tenantName} canal=${canal} idioma=${idioma}`);
  }

  // WhatsApp / default
  const pLang = norm(tenant?.[`prompt_${idioma}`]);
  if (pLang) return pLang;

  const p = norm(tenant?.prompt);
  if (p) return p;

  throw new Error(`PROMPT_MISSING: tenant=${tenantName} canal=${canal} idioma=${idioma}`);
}

/**
 * Bienvenida DB-only:
 * - Prioridad: bienvenida por idioma
 * - Luego: bienvenida base
 * - Si no existe -> fallback mínimo (solo saludo), porque si no, quedas sin saludo.
 *   (Si quieres que también sea strict, te lo pongo strict.)
 */
export function getBienvenidaPorCanal(canal: Canal, tenant: any, idioma: Idioma = "es"): string {
  const nombre = tenant?.name || "nuestro negocio";

  if (isMeta(canal)) {
    const bLang = norm(tenant?.[`bienvenida_meta_${idioma}`] ?? tenant?.meta_config?.[`bienvenida_meta_${idioma}`]);
    if (bLang) return bLang;

    const b = norm(tenant?.bienvenida_meta ?? tenant?.meta_config?.bienvenida_meta);
    if (b) return b;

    // fallback mínimo (saludo) para no quedarte mudo
    return generarBienvenidaPorIdioma(nombre, idioma);
  }

  const bLang = norm(tenant?.[`mensaje_bienvenida_${idioma}`]);
  if (bLang) return bLang;

  const b = norm(tenant?.mensaje_bienvenida);
  if (b) return b;

  return generarBienvenidaPorIdioma(nombre, idioma);
}

function generarBienvenidaPorIdioma(nombre: string, idioma: string): string {
  const mensajes: Record<string, string> = {
    es: `Hola 👋 Soy Amy, bienvenida a ${nombre}. ¿En qué puedo ayudarte hoy?`,
    en: `Hi 👋 I'm Amy, welcome to ${nombre}. How can I help you today?`,
  };
  return mensajes[idioma] || mensajes.es;
}
