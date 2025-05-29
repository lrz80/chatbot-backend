"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectarIdioma = detectarIdioma;
// src/lib/detectarIdioma.ts
const openai_1 = __importDefault(require("openai"));
async function detectarIdioma(texto) {
    const openai = new openai_1.default({ apiKey: process.env.OPENAI_API_KEY || '' });
    const respuesta = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
            {
                role: 'user',
                content: `Detecta el idioma de este mensaje y responde solo con el código ISO 639-1 (por ejemplo: en, es, pt):\n\n"${texto}"`,
            },
        ],
        temperature: 0,
    });
    const idioma = respuesta.choices[0]?.message?.content?.trim().toLowerCase();
    return idioma || 'es';
}
