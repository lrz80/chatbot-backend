"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptTemplate = PromptTemplate;
const db_1 = __importDefault(require("../lib/db"));
function sanitize(text) {
    return text.replace(/[\n\r]+/g, " ").trim();
}
async function PromptTemplate({ idioma, categoria, tenant_id, funciones_asistente, info_clave, }) {
    let bienvenida = "";
    let funciones = sanitize(funciones_asistente || "");
    let info = sanitize(info_clave || "");
    if (!funciones || !info) {
        try {
            const result = await db_1.default.query("SELECT funciones_asistente, info_clave FROM tenants WHERE id = $1", [tenant_id]);
            const data = result.rows[0];
            if (!funciones && data?.funciones_asistente)
                funciones = sanitize(data.funciones_asistente);
            if (!info && data?.info_clave)
                info = sanitize(data.info_clave);
        }
        catch (err) {
            console.error("❌ Error al consultar tenant para prompt:", err);
        }
    }
    if (!funciones)
        funciones = "Responder preguntas frecuentes sobre el negocio.";
    if (!info)
        info = "El negocio ofrece servicios profesionales.";
    const categoriasMap = {
        beauty: idioma === "es-ES" ? "nuestro centro de belleza" : "our beauty center",
        fitness: idioma === "es-ES" ? "nuestro centro fitness" : "our fitness center",
        default: idioma === "es-ES" ? "nuestro negocio" : "our business",
    };
    const categoriaTexto = categoriasMap[categoria] || categoriasMap["default"];
    // 🗣️ Prompt y bienvenida personalizados
    if (idioma === "es-ES") {
        bienvenida = `Hola, soy Amy. Bienvenido a ${categoriaTexto}. ¿En qué puedo ayudarte?`;
        return {
            bienvenida,
            prompt: `
Hablas como Amy, una asistente telefónica real, cálida y segura.
Tu trabajo es ayudar al cliente como si fueras parte del equipo de ${categoriaTexto}.
Responde siempre en español neutro, con frases breves y claras. No uses términos técnicos.
Ayuda al cliente con lo siguiente: ${funciones}.
Información clave que debes tener en cuenta: ${info}.
No digas que eres un asistente virtual. Habla como una persona real del negocio.
Si el cliente dice gracias o se despide, responde cordialmente y finaliza la conversación.
      `.trim(),
        };
    }
    bienvenida = `Hi, I'm Amy. Welcome to ${categoriaTexto}. How can I help you?`;
    return {
        bienvenida,
        prompt: `
You speak as Amy, a natural, friendly and professional voice assistant.
You help the caller just like a real staff member of ${categoriaTexto}.
Always speak in short, natural sentences in clear English.
Your role includes: ${funciones}.
Important info to keep in mind: ${info}.
Never say you're a virtual assistant. Speak like a real human.
If the user says goodbye or thanks, end the call politely.
    `.trim(),
    };
}
