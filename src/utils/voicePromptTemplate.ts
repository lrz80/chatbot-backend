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

  // Si no se enviaron manualmente, buscar desde DB (solo como fallback)
  if (!funciones || !info) {
    try {
      const result = await pool.query(
        "SELECT name, funciones_asistente, info_clave FROM tenants WHERE id = $1",
        [tenant_id]
      );
      const negocio = result.rows[0];

      if (!funciones && negocio?.funciones_asistente)
        funciones = sanitize(negocio.funciones_asistente);
      if (!info && negocio?.info_clave)
        info = sanitize(negocio.info_clave);
    } catch (err) {
      console.error("❌ Error al consultar tenant para voicePromptTemplate:", err);
    }
  }

  // Valores por defecto si siguen vacíos
  if (!funciones) funciones = "Responder preguntas frecuentes del negocio.";
  if (!info) info = "El negocio ofrece servicios profesionales en su rubro.";

  const categoriasMap: Record<string, string> = {
    beauty: idioma === "es-ES" ? "nuestro centro de belleza" : "beauty center",
    fitness: idioma === "es-ES" ? "nuestro centro fitness" : "fitness center",
    default: idioma === "es-ES" ? "nuestro negocio" : "business",
  };

  const categoriaTexto = categoriasMap[categoria] || categoriasMap["default"];

  if (idioma === "es-ES") {
    bienvenida = `Hola, soy Amy. Bienvenido a ${categoriaTexto}. ¿En qué puedo ayudarte?`;
    return {
      bienvenida,
      prompt: `Actúa como un asistente de voz profesional que responde en español. Tu rol es ayudar a los clientes de un negocio de categoría "${categoria}". 
Debes ser directo, claro y amable. El asistente debe cumplir las siguientes funciones: ${funciones}.
Información relevante del negocio: ${info}`,
    };
  }

  // Default a inglés
  bienvenida = `Hi, I'm Amy. Welcome to our ${categoriaTexto}. How can I help you today?`;
  return {
    bienvenida,
    prompt: `Act as a professional voice assistant that responds in English. Your role is to help customers of a business in the "${categoria}" category.
You must be clear, friendly, and helpful. The assistant's functions are: ${funciones}.
Business information: ${info}`,
  };
}
