import pool from '../lib/db';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

async function generarFaqsSugeridas() {
    const { rows: preguntas } = await pool.query(`
        SELECT * FROM faq_sugeridas
        WHERE veces_repetida >= 3 AND procesada = false AND canal IS NOT NULL
        LIMIT 10
      `);      

  for (const p of preguntas) {
    let canal = (p.canal || '').toLowerCase();
let estilo = '';

if (canal === 'voz') {
  estilo = 'Tu respuesta será hablada, así que evita frases largas o técnicas. Sé claro, directo y cálido.';
} else if (canal === 'facebook' || canal === 'instagram') {
  estilo = 'El cliente está escribiendo por redes sociales. Usa un tono amigable, informal pero profesional.';
} else {
  estilo = 'El cliente está en WhatsApp. Sé breve, directo y cordial.';
}

const prompt = `Un cliente ha preguntado frecuentemente: "${p.pregunta}". ${estilo} Responde de forma útil como si fueras el asistente del negocio.`;

    try {
      const respuesta = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: 'system', content: "Eres un asistente de atención al cliente amigable y claro." },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
      });

      const sugerida = respuesta.choices[0]?.message?.content?.trim();
      if (sugerida) {
        await pool.query(
          `UPDATE faq_sugeridas 
           SET respuesta_sugerida = $1, procesada = true
           WHERE id = $2`,
          [sugerida, p.id]
        );
        console.log(`✅ FAQ generada para: "${p.pregunta}"`);
      }
    } catch (err) {
      console.error(`❌ Error generando respuesta para "${p.pregunta}":`, err);
    }
  }
}

generarFaqsSugeridas().then(() => {
  console.log("🎯 Proceso completado.");
  process.exit(0);
});