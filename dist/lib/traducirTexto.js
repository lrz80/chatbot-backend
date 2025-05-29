"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.traducirTexto = traducirTexto;
const openai_1 = __importDefault(require("openai"));
const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY });
async function traducirTexto(texto, idioma) {
    const prompt = `Traduce el siguiente mensaje al idioma "${idioma}". Solo responde con la traducción:\n\n"${texto}"`;
    const res = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
    });
    return res.choices[0]?.message?.content?.trim() || texto;
}
