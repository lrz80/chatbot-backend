import pool from '../lib/db';
import OpenAI from 'openai';
import { detectarIntencion } from '../lib/detectarIntencion';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

function normalizarCanal(canal: string) {
  return (canal === 'facebook' || canal === 'instagram') ? 'meta' : canal;
}

async function generarFaqsSugeridas() {
  // Solo las de canal meta (unificado) y por tenant
  const { rows: preguntas } = await pool.query(`
    SELECT id, tenant_id, canal, pregunta, idioma
    FROM faq_sugeridas
    WHERE procesada = false
      AND veces_repetida >= 3
      AND canal IN ('meta')    -- <— clave para Meta
    ORDER BY ultima_fecha DESC
    LIMIT 50
  `);

  for (const p of preguntas) {
    const tenantId = p.tenant_id;
    const canal = normalizarCanal(p.canal || 'meta');

    // Detectar intención (si tu función devuelve objeto, ajusta esta línea)
    const det = await detectarIntencion(p.pregunta, tenantId);
    const intencion = typeof det === 'string' ? det : det?.intencion || null;

    if (intencion) {
      // Verifica EXISTENCIA por tenant + canal + intención en faqs oficiales
      const yaExisteFaq = await pool.query(
        `SELECT 1 FROM faqs WHERE tenant_id = $1 AND canal = $2 AND intencion = $3 LIMIT 1`,
        [tenantId, canal, intencion]
      );
      if ((yaExisteFaq.rowCount ?? 0) > 0) {
        console.log(`⏭ Ya existe FAQ oficial (${tenantId}/${canal}/${intencion}). Omito "${p.pregunta}"`);
        await pool.query(`UPDATE faq_sugeridas SET procesada = true WHERE id = $1`, [p.id]); // la marcamos procesada
        continue;
      }

      // Evita colisión con otras sugeridas del mismo tenant/canal/intención ya procesadas
      const yaExisteSugerida = await pool.query(
        `SELECT 1 FROM faq_sugeridas
         WHERE tenant_id = $1 AND canal = $2 AND intencion = $3 AND procesada = true
         LIMIT 1`,
        [tenantId, canal, intencion]
      );
      if ((yaExisteSugerida.rowCount ?? 0) > 0) {
        console.log(`⏭ Ya existe sugerida procesada (${tenantId}/${canal}/${intencion}). Omito "${p.pregunta}"`);
        await pool.query(`UPDATE faq_sugeridas SET procesada = true WHERE id = $1`, [p.id]);
        continue;
      }
    }

    // (Opcional) carga prompt del tenant para dar contexto mejor a la respuesta
    const { rows: trows } = await pool.query(
      `SELECT t.name, COALESCE(m.prompt_meta, t.prompt) AS prompt_ctx
       FROM tenants t LEFT JOIN meta_configs m ON t.id = m.tenant_id
       WHERE t.id = $1`,
      [tenantId]
    );
    const negocio = trows[0]?.name || 'el negocio';
    const promptCtx = trows[0]?.prompt_ctx || '';

    const prompt = [
      `Eres el asistente de "${negocio}". Responde clara, breve y útil a esta pregunta frecuente:`,
      `"${p.pregunta}"`,
      promptCtx ? `Usa la siguiente información del negocio cuando sea relevante:\n${promptCtx}` : ''
    ].join('\n\n').trim();

    try {
      const respuesta = await openai.chat.completions.create({
        model: "gpt-4o-mini",   // más preciso/eficiente que 3.5
        messages: [
          { role: 'system', content: "Eres un asistente de negocios claro, directo y útil. Nunca inventes datos." },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      const sugerida = respuesta.choices[0]?.message?.content?.trim();

      if (sugerida) {
        await pool.query(
          `UPDATE faq_sugeridas 
           SET respuesta_sugerida = $1,
               procesada = true,
               intencion = $2,
               canal = $3  -- normaliza a 'meta' por consistencia
           WHERE id = $4`,
          [sugerida, intencion || null, canal, p.id]
        );
        console.log(`✅ Generada FAQ (${tenantId}/${canal}) intención "${intencion}": "${p.pregunta}"`);
      } else {
        await pool.query(`UPDATE faq_sugeridas SET procesada = true WHERE id = $1`, [p.id]);
        console.log(`⚠️ Sin respuesta útil. Marcada como procesada: id ${p.id}`);
      }
    } catch (err) {
      console.error(`❌ Error generando respuesta para "${p.pregunta}":`, err);
    }
  }
}

generarFaqsSugeridas()
  .then(() => {
    console.log("🎯 Proceso completado.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("❌ Proceso falló:", e);
    process.exit(1);
  });
