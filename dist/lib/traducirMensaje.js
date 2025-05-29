"use strict";
// backend/src/lib/traducirMensaje.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.traducirMensaje = traducirMensaje;
const openai_1 = __importDefault(require("openai"));
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY || '' });
async function traducirMensaje(texto, idiomaObjetivo) {
    try {
        const prompt = `Traduce el siguiente texto al idioma '${idiomaObjetivo}' manteniendo un tono amable y profesional:\n\n${texto}`;
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: "Eres un traductor profesional." },
                { role: "user", content: prompt },
            ],
            temperature: 0.3,
        });
        const traduccion = response.choices[0]?.message?.content?.trim();
        return traduccion || texto;
    }
    catch (err) {
        console.error("❌ Error traduciendo mensaje:", err);
        return texto; // fallback al original si falla
    }
}
