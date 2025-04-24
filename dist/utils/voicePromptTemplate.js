"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptTemplate = PromptTemplate;
// utils/voicePromptTemplate.ts
const db_1 = __importDefault(require("../lib/db"));
function sanitize(text) {
    return text.replace(/[\n\r]+/g, " ").trim();
}
async function PromptTemplate({ idioma, categoria, tenant_id }) {
    let bienvenida = "";
    let funciones = "";
    let info = "";
    // 🧠 Consultar datos del negocio desde la base de datos
    try {
        const result = await db_1.default.query("SELECT name, funciones_asistente, info_clave FROM tenants WHERE id = $1", [tenant_id]);
        const negocio = result.rows[0];
        if (!negocio) {
            console.warn(`⚠️ No se encontró tenant con ID: ${tenant_id}`);
            funciones = "Responder preguntas frecuentes del negocio.";
            info = "El negocio ofrece servicios profesionales en su rubro.";
        }
        else {
            funciones = sanitize(negocio.funciones_asistente || "Responder preguntas frecuentes del negocio.");
            info = sanitize(negocio.info_clave || "El negocio ofrece servicios profesionales en su rubro.");
        }
    }
    catch (err) {
        console.error("❌ Error al consultar tenant para voicePromptTemplate:", err);
        funciones = "Responder preguntas frecuentes del negocio.";
        info = "El negocio ofrece servicios profesionales en su rubro.";
    }
    const categoriasMap = {
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
