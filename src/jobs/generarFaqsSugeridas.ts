import pool from '../lib/db';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

async function generarFaqsSugeridas() {
  const { rows: preguntas } = await pool.query(`
    SELECT * FROM faq_sugeridas
    WHERE veces_repetida >= 3 AND procesada = false
    LIMIT 10
  `);

  for (const p of preguntas) {
    const prompt = `Esta es una pregunta frecuente que los clientes hacen a un negocio llamado "${p.pregunta}". Responde de forma clara, breve y útil como si fueras el asistente del negocio.`;

    try {
      const respuesta = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: 'system', content: "Eres un asistente de negocios amigable y claro." },
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
        console.log(`✅ FAQ sugerida generada para: "${p.pregunta}"`);
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
