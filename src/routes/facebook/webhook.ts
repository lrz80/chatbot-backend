// src/routes/facebook/webhook.ts

import express from 'express';
import pool from '../../lib/db';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido, buscarRespuestaDesdeFlowsTraducido } from '../../lib/respuestasTraducidas';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { enviarMensajePorPartes } from '../../lib/enviarMensajePorPartes';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const router = express.Router();

router.get('/api/facebook/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'testtoken';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook de Facebook verificado');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }

  res.sendStatus(400);
});

router.post('/api/facebook/webhook', async (req, res) => {
  console.log("🌐 Webhook Meta recibido:", JSON.stringify(req.body, null, 2));
  try {
    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') return res.sendStatus(404);

    res.sendStatus(200);

    for (const entry of body.entry) {
      const pageId = entry.id;

      for (const messagingEvent of entry.messaging) {
        if (!messagingEvent.message || messagingEvent.message.is_echo || !messagingEvent.message.text) {
          console.log('⏭️ Evento ignorado');
          continue;
        }

        const senderId = messagingEvent.sender.id;
        const messageId = messagingEvent.message.mid;
        const userMessage = messagingEvent.message.text;

        const idioma = await detectarIdioma(userMessage);

        // 📢 Unir tenants + meta-configs
        const { rows } = await pool.query(
          `SELECT t.*, m.prompt_meta, m.bienvenida_meta 
           FROM tenants t
           LEFT JOIN meta_configs m ON t.id = m.tenant_id
           WHERE t.facebook_page_id = $1 OR t.instagram_page_id = $1 LIMIT 1`,
          [pageId]
        );
        if (rows.length === 0) continue;

        const tenant = rows[0];
        const isInstagram = tenant.instagram_page_id && tenant.instagram_page_id === pageId;
        const canal = isInstagram ? 'instagram' : 'facebook';
        const tenantId = tenant.id;
        const accessToken = tenant.facebook_access_token;

        const existingMsg = await pool.query(
          `SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
          [tenantId, messageId]
        );
        if (existingMsg.rows.length > 0) continue;

        // ✅ SOLO AHORA sumamos 1
        const tenantRes = await pool.query('SELECT membresia_inicio FROM tenants WHERE id = $1', [tenantId]);
        const membresiaInicio = tenantRes.rows[0]?.membresia_inicio;

        await pool.query(`
          INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
          VALUES ($1, $2, $3, 1)
          ON CONFLICT (tenant_id, canal, mes) DO UPDATE SET usados = uso_mensual.usados + 1
        `, [tenantId, canal, membresiaInicio]);

        let faqs = [];
        let flows = [];
        try {
          const resFaqs = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenantId]);
          faqs = resFaqs.rows || [];
        } catch {}
        try {
          const resFlows = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenantId]);
          const raw = resFlows.rows[0]?.data;
          flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!Array.isArray(flows)) flows = [];
        } catch {}

        const { intencion, nivel_interes } = await detectarIntencion(userMessage);
        const intencionLower = intencion?.toLowerCase() || '';

        let respuesta: string | null = null;

        if (["finalizar", "cerrar", "terminar", "gracias", "eso es todo", "no necesito más"].some(p => intencionLower.includes(p))) {
          respuesta = "¡Gracias por contactarnos! Si necesitas más información, no dudes en escribirnos. ¡Hasta pronto!";
        } else {
          respuesta = await buscarRespuestaSimilitudFaqsTraducido(faqs, userMessage, idioma)
            ?? await buscarRespuestaDesdeFlowsTraducido(flows, userMessage, idioma);

            if (!respuesta) {
              const mensajeBienvenida = tenant.bienvenida_meta?.trim() || "Hola, soy Amy, ¿en qué puedo ayudarte hoy?";
              const promptMeta = tenant.prompt_meta?.trim() || "Información del negocio no disponible.";
            
              const saludoDetectado = ["hola", "hello", "buenos días", "buenas tardes", "buenas noches", "saludos"].some(p =>
                userMessage.toLowerCase().includes(p)
              );
            
              const dudaGenericaDetectada = ["quiero más información", "i want more information", "me interesa", "más detalles", "información"].some(p =>
                userMessage.toLowerCase().includes(p)
              );
            
              if (saludoDetectado) {
                respuesta = mensajeBienvenida;
              } else if (dudaGenericaDetectada) {
                respuesta = "¡Claro! ¿Qué información específica te interesa? Puedo ayudarte con precios, servicios, horarios u otros detalles.";
              } else {
                // 🎯 Lógica de traducción para que el prompt se adapte al idioma del cliente
                const idiomaCliente = await detectarIdioma(userMessage);
                let promptMetaAdaptado = promptMeta;
                let promptGenerado = '';

                if (idiomaCliente !== 'es') {
                  try {
                    promptMetaAdaptado = await traducirMensaje(promptMeta, idiomaCliente);

                    promptGenerado = `You are Amy, a helpful virtual assistant for the local business "${tenant.nombre}". A customer asked: "${userMessage}". Respond clearly, briefly, and helpfully using the following information:\n\n${promptMetaAdaptado}`;
                  } catch (err) {
                    console.error('❌ Error traduciendo prompt_meta:', err);
                    promptGenerado = `You are Amy, a virtual assistant. A customer asked: "${userMessage}". Reply concisely.`;
                  }
                } else {
                  promptGenerado = `Eres Amy, una asistente virtual para el negocio local "${tenant.nombre}". Un cliente preguntó: "${userMessage}". Responde de forma clara, breve y útil usando esta información:\n\n${promptMeta}`;
                }

                try {
                  const completion = await openai.chat.completions.create({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'user', content: promptGenerado }],
                    max_tokens: 400,
                  });

                  respuesta = completion.choices[0]?.message?.content?.trim() || "Lo siento, no tengo información disponible.";
                  const tokensConsumidos = completion.usage?.total_tokens || 0;

                  if (tokensConsumidos > 0) {
                    await pool.query(
                      `UPDATE uso_mensual SET usados = usados + $1
                      WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`,
                      [tokensConsumidos, tenantId]
                    );
                  }
                } catch (err) {
                  console.error('❌ Error con OpenAI:', err);
                  respuesta = "Lo siento, no tengo información disponible en este momento.";
                }

                try {
                  const completion = await openai.chat.completions.create({
                    model: 'gpt-3.5-turbo',
                    messages: [{ role: 'user', content: promptGenerado }],
                    max_tokens: 400,
                  });
            
                  respuesta = completion.choices[0]?.message?.content?.trim() || "Lo siento, no tengo información disponible.";
                  const tokensConsumidos = completion.usage?.total_tokens || 0;
            
                  if (tokensConsumidos > 0) {
                    await pool.query(
                      `UPDATE uso_mensual SET usados = usados + $1
                       WHERE tenant_id = $2 AND canal = 'tokens_openai' AND mes = date_trunc('month', CURRENT_DATE)`,
                      [tokensConsumidos, tenantId]
                    );
                  }
                } catch (err) {
                  console.error('❌ Error con OpenAI:', err);
                  respuesta = "Lo siento, no tengo información disponible en este momento.";
                }
              }
            }                        
        }

        respuesta = respuesta ?? "Lo siento, no tengo información disponible.";
        const idiomaFinal = await detectarIdioma(respuesta);
        if (idiomaFinal !== idioma) {
          respuesta = await traducirMensaje(respuesta, idioma);
        }

        // 💡 Solo guardar si la intención es realmente de venta
        const intencionesValidas = ['comprar', 'pagar', 'precio', 'reservar'];

        if (intencionesValidas.includes(intencion) && nivel_interes >= 2) {
          await pool.query(
            `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes, message_id, fecha)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (tenant_id, message_id) DO NOTHING`,
            [tenantId, senderId, canal, userMessage, intencion, nivel_interes, messageId]
          );
        }

        // 📝 Guardar mensaje del usuario
        await pool.query(
          `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, message_id)
          VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
          ON CONFLICT (tenant_id, message_id) DO NOTHING`,
          [tenantId, userMessage, canal, senderId || 'anónimo', messageId]
        );

        const yaExisteContenidoReciente = await pool.query(
          `SELECT 1 FROM messages WHERE tenant_id = $1 AND sender = 'bot' AND canal = $2 AND content = $3 
           AND timestamp >= NOW() - INTERVAL '5 seconds' LIMIT 1`,
          [tenantId, canal, respuesta]
        );
        if (yaExisteContenidoReciente.rows.length === 0) {
          try {
            await enviarMensajePorPartes({
              respuesta,
              senderId,
              tenantId,
              canal,
              messageId,
              accessToken,
            });
          } catch (err) {
            console.error('❌ Error al enviar mensaje por partes:', err);
          }
        }

        await pool.query(`
          INSERT INTO interactions (tenant_id, canal, created_at, message_id)
          VALUES ($1, $2, NOW(), $3)
          ON CONFLICT DO NOTHING
        `, [tenantId, canal, messageId]);        

      }
    }
  } catch (error: any) {
    console.error('❌ Error en webhook:', error.response?.data || error.message || error);
  }
});

export default router;
