// utils/voicePromptTemplate.ts
import pool from "../lib/db";

type PromptData = {
  idioma: string;
  categoria: string;
  tenant_id: string;
  funciones_asistente?: string;
  info_clave?: string;
};

function sanitize(text: string): string {
  return text.replace(/[\n\r]+/g, " ").trim();
}

export async function PromptTemplate({
  idioma,
  categoria,
  tenant_id,
  funciones_asistente,
  info_clave,
}: PromptData) {
  let bienvenida = "";
  let funciones = sanitize(funciones_asistente || "");
  let info = sanitize(info_clave || "");

  if (!funciones || !info) {
    try {
      const result = await pool.query(
        "SELECT funciones_asistente, info_clave FROM tenants WHERE id = $1",
        [tenant_id]
      );
      const data = result.rows[0];
      if (!funciones && data?.funciones_asistente)
        funciones = sanitize(data.funciones_asistente);
      if (!info && data?.info_clave)
        info = sanitize(data.info_clave);
    } catch (err) {
      console.error("❌ Error al consultar tenant para prompt:", err);
    }
  }

  if (!funciones) funciones = "Responder preguntas frecuentes.";
  if (!info) info = "El negocio ofrece servicios profesionales.";

  const categoriasMap: Record<string, string> = {
    beauty: idioma === "es-ES" ? "nuestro centro de belleza" : "our beauty center",
    fitness: idioma === "es-ES" ? "nuestro centro fitness" : "our fitness center",
    default: idioma === "es-ES" ? "nuestro negocio" : "our business",
  };

  const categoriaTexto = categoriasMap[categoria] || categoriasMap["default"];

  if (idioma === "es-ES") {
    bienvenida = `Hola, soy Amy. Bienvenido a ${categoriaTexto}. ¿En qué puedo ayudarte?`;
    return {
      bienvenida,
      prompt: `Eres un asistente de voz en español. Funciones: ${funciones}. Datos del negocio: ${info}. Responde claro y amable.`,
    };
  }

  bienvenida = `Hi, I'm Amy. Welcome to ${categoriaTexto}. How can I help you?`;
  return {
    bienvenida,
    prompt: `You are a voice assistant in English. Tasks: ${funciones}. Business info: ${info}. Respond clearly and helpfully.`,
  };
}
