// ✅ src/routes/facebook/webhook.ts

import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import { getRespuestaCompleta } from '../../lib/getRespuestaCompleta';
import { detectarIdioma } from '../../lib/detectarIdioma';
import { traducirMensaje } from '../../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido, buscarRespuestaDesdeFlowsTraducido } from '../../lib/respuestasTraducidas';
import { getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { detectarIntencion } from '../../lib/detectarIntencion';

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
  try {
    const body = req.body;
    if (body.object !== 'page') return res.sendStatus(404);

    for (const entry of body.entry) {
      const pageId = entry.id;
      for (const messagingEvent of entry.messaging) {
        const senderId = messagingEvent.sender.id;

        if (messagingEvent.message && !messagingEvent.message.is_echo) {
          const userMessage = messagingEvent.message.text || '';
          const idioma = await detectarIdioma(userMessage);
          console.log('📩 Mensaje recibido:', userMessage, '| 🌍 Idioma detectado:', idioma);

          const { rows } = await pool.query(
            'SELECT * FROM tenants WHERE facebook_page_id = $1 OR instagram_page_id = $1 LIMIT 1',
            [pageId]
          );
          if (rows.length === 0) continue;

          const tenant = rows[0];
          const canal = tenant.instagram_page_id === pageId ? 'instagram' : 'facebook';
          const tenantId = tenant.id;
          const accessToken = tenant.facebook_access_token;

          // 📥 Cargar FAQs y Flows
          let faqs: any[] = [];
          let flows: any[] = [];

          try {
            const resFaqs = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenantId]);
            faqs = resFaqs.rows || [];
          } catch {}

          try {
            const resFlows = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenantId]);
            const raw = resFlows.rows[0]?.data;
            flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
          } catch {}

          // 🧠 Buscar respuesta
          let respuesta = await buscarRespuestaSimilitudFaqsTraducido(faqs, userMessage, idioma)
            || await buscarRespuestaDesdeFlowsTraducido(flows, userMessage, idioma)
            || await getRespuestaCompleta({ canal, tenant, input: userMessage, idioma });

          const idiomaFinal = await detectarIdioma(respuesta);
          if (idiomaFinal !== idioma) {
            respuesta = await traducirMensaje(respuesta, idioma);
          }

          // 🧠 Analizar intención
          try {
            const { intencion, nivel_interes } = await detectarIntencion(userMessage);
            const intencionLower = intencion.toLowerCase();

            if (["comprar", "compra", "pagar", "agendar", "reservar", "confirmar"].some(p => intencionLower.includes(p))) {
              await pool.query(
                `UPDATE clientes SET segmento = 'cliente' WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`,
                [tenantId, senderId]
              );
            }

            await pool.query(
              `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [tenantId, senderId, canal, userMessage, intencion, nivel_interes]
            );

            if (nivel_interes >= 4) {
              const configRes = await pool.query(`SELECT * FROM follow_up_settings WHERE tenant_id = $1`, [tenantId]);
              const config = configRes.rows[0];

              if (config) {
                let mensajeSeguimiento = config.mensaje_general || '¿Te gustaría que te ayudáramos a avanzar?';
                if (intencionLower.includes('precio') && config.mensaje_precio) mensajeSeguimiento = config.mensaje_precio;
                else if (intencionLower.includes('agendar') && config.mensaje_agendar) mensajeSeguimiento = config.mensaje_agendar;
                else if (intencionLower.includes('ubicacion') && config.mensaje_ubicacion) mensajeSeguimiento = config.mensaje_ubicacion;

                const idiomaMsj = await detectarIdioma(mensajeSeguimiento);
                if (idiomaMsj !== idioma) mensajeSeguimiento = await traducirMensaje(mensajeSeguimiento, idioma);

                const fechaEnvio = new Date();
                fechaEnvio.setMinutes(fechaEnvio.getMinutes() + (config.minutos_espera || 5));

                await pool.query(
                  `INSERT INTO mensajes_programados (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
                   VALUES ($1, $2, $3, $4, $5, false)`,
                  [tenantId, canal, senderId, mensajeSeguimiento, fechaEnvio]
                );
              }
            }
          } catch (e) {
            console.warn('⚠️ No se pudo analizar intención:', e);
          }

          // 💾 Guardar en BD
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
             VALUES ($1, 'user', $2, NOW(), $3, $4)`,
            [tenantId, userMessage, canal, senderId]
          );
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
             VALUES ($1, 'bot', $2, NOW(), $3)`,
            [tenantId, respuesta, canal]
          );
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, created_at)
             VALUES ($1, $2, NOW())`,
            [tenantId, canal]
          );

          await incrementarUsoPorNumero(tenant.twilio_number);

          // 📤 Enviar respuesta
          await axios.post(
            `https://graph.facebook.com/v19.0/me/messages`,
            {
              recipient: { id: senderId },
              message: { text: respuesta },
            },
            { params: { access_token: accessToken } }
          );

          console.log(`✅ Respuesta enviada al usuario (${canal})`);
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error: any) {
    console.error('❌ Error en webhook:', error.response?.data || error.message || error);
    res.sendStatus(500);
  }
});

export default router;
