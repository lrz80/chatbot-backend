"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectarIntencion = detectarIntencion;
const openai_1 = __importDefault(require("openai"));
async function detectarIntencion(mensaje) {
    const openai = new openai_1.default({
        apiKey: process.env.OPENAI_API_KEY || '',
    });
    const prompt = `
Eres un sistema que analiza mensajes de clientes para clasificar su intención y nivel de interés.

Analiza el siguiente mensaje:
"${mensaje}"

Clasifica según estas intenciones posibles:
- "comprar"
- "pagar"
- "precio"
- "reservar"
- "cancelar"
- "saludo"
- "duda"
- "no_interesado"

Y estos niveles de interés:
- 1: Bajo (curioso, sin intención clara)
- 2: Medio (interesado pero no decidido)
- 3: Alto (quiere comprar o reservar pronto)

Si el mensaje es un saludo como "hola", "buenas", "hello", "saludos", etc., la intención debe ser "saludo" y el nivel_interes debe ser 1.

⚠️ Si el mensaje contiene una negación como "no quiero pagar" o "no me interesa", la intención debe ser "no_interesado".

Responde solo en JSON con este formato exacto:
{
  "intencion": "una de las opciones anteriores",
  "nivel_interes": 1 | 2 | 3
}
`;
    const completion = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
    });
    let content = completion.choices[0]?.message?.content || '{}';
    content = content.replace(/```json|```/g, '').trim();
    let data = {
        intencion: 'no_detectada',
        nivel_interes: 1,
    };
    try {
        const parsed = JSON.parse(content);
        if (parsed.intencion && parsed.nivel_interes) {
            data = {
                intencion: parsed.intencion.toLowerCase(),
                nivel_interes: Math.min(3, Math.max(1, parseInt(parsed.nivel_interes))),
            };
        }
    }
    catch (error) {
        console.error('❌ Error parseando intención:', error);
    }
    // ✅ Refuerzo manual para saludos
    const saludos = ['hola', 'hello', 'buenos días', 'buenas tardes', 'buenas noches', 'saludos'];
    const msgLower = mensaje.toLowerCase();
    if (saludos.some(s => msgLower.includes(s))) {
        data.intencion = 'saludo';
        data.nivel_interes = 1;
    }
    return data;
}
