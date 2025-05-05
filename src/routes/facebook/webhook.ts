import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import { getRespuestaCompleta } from '../../lib/getRespuestaCompleta';
import { detectarIntencion } from '../../lib/detectarIntencion';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';
import { getBienvenidaPorCanal } from '../../lib/getPromptPorCanal';


const router = express.Router();

// ✅ Verificación de Webhook
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

// ✅ Mensajes entrantes
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
          console.log('📩 Mensaje recibido:', userMessage);

          // 🔍 Buscar tenant
          const { rows } = await pool.query(
            'SELECT * FROM tenants WHERE facebook_page_id = $1 OR instagram_page_id = $1 LIMIT 1',
            [pageId]
          );

          if (rows.length === 0) {
            console.error('❌ No se encontró tenant para page_id:', pageId);
            continue;
          }

          const tenant = rows[0];
          const canal = tenant.instagram_page_id === pageId ? 'instagram' : 'facebook';
          const tenantId = tenant.id;
          const accessToken = tenant.facebook_access_token;

          // 💾 Buscar en contactos previos (por si fue cargado manualmente)
          const contactoRes = await pool.query(
            `SELECT nombre, segmento FROM contactos WHERE tenant_id = $1 AND telefono = $2 LIMIT 1`,
            [tenantId, senderId]
          );
          const contacto = contactoRes.rows[0];

          const nombre =
            messagingEvent.sender.name || contacto?.nombre || null;

          const segmento =
            contacto?.segmento || 'lead';

          await pool.query(
            `INSERT INTO clientes (tenant_id, canal, contacto, creado, nombre, segmento)
            VALUES ($1, $2, $3, NOW(), $4, $5)
            ON CONFLICT (contacto) DO UPDATE SET
              nombre = COALESCE(EXCLUDED.nombre, clientes.nombre),
              segmento = CASE
                WHEN clientes.segmento = 'lead' AND EXCLUDED.segmento = 'cliente' THEN 'cliente'
                ELSE clientes.segmento
              END`,
            [tenantId, canal, senderId, nombre, segmento]
          );

          // 🤖 Obtener respuesta
          const mensajeNormalizado = userMessage
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();

          const esSaludo = ['hola', 'buenas', 'hello', 'hi', 'hey'].includes(mensajeNormalizado);

          const respuestaFinal = esSaludo
            ? getBienvenidaPorCanal(canal, tenant)
            : await getRespuestaCompleta({ canal, tenant, input: userMessage });

          // 💬 Guardar mensaje del usuario
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
             VALUES ($1, 'user', $2, NOW(), $3, $4)`,
            [tenantId, userMessage, canal, senderId]
          );

          // 💬 Guardar respuesta del bot
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
             VALUES ($1, 'bot', $2, NOW(), $3)`,
            [tenantId, respuestaFinal, canal]
          );

          // 📊 Guardar interacción
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, created_at)
             VALUES ($1, $2, NOW())`,
            [tenantId, canal]
          );

          // 🔢 Incrementar contador de uso
          await incrementarUsoPorNumero(tenant.twilio_number);

          // 🧠 Inteligencia de ventas y seguimiento
          try {
            const { intencion, nivel_interes } = await detectarIntencion(userMessage);

            await pool.query(
              `INSERT INTO sales_intelligence (tenant_id, contacto, canal, mensaje, intencion, nivel_interes)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [tenantId, senderId, canal, userMessage, intencion, nivel_interes]
            );

            // 🎯 Si es lead y la intención es fuerte, subir a "cliente"
            const intentLower = intencion.toLowerCase();
            if (
              ['comprar', 'compra', 'pagar', 'agendar', 'reservar', 'confirmar'].some(palabra =>
                intentLower.includes(palabra)
              )
            ) {
              await pool.query(
                `UPDATE clientes
                 SET segmento = 'cliente'
                 WHERE tenant_id = $1 AND contacto = $2 AND segmento = 'lead'`,
                [tenantId, senderId]
              );
            }

            if (nivel_interes >= 4) {
              const configRes = await pool.query(
                `SELECT * FROM follow_up_settings WHERE tenant_id = $1`,
                [tenantId]
              );
              const config = configRes.rows[0];

              if (config) {
                let mensajeSeguimiento = config.mensaje_general || "¡Hola! ¿Te gustaría que te ayudáramos a avanzar?";
                const intent = intentLower;

                if (intent.includes('precio') && config.mensaje_precio) mensajeSeguimiento = config.mensaje_precio;
                else if (intent.includes('agendar') && config.mensaje_agendar) mensajeSeguimiento = config.mensaje_agendar;
                else if (intent.includes('ubicacion') && config.mensaje_ubicacion) mensajeSeguimiento = config.mensaje_ubicacion;

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

          // 📤 Enviar respuesta a Meta
          await axios.post(
            `https://graph.facebook.com/v19.0/me/messages`,
            {
              recipient: { id: senderId },
              message: { text: respuestaFinal },
            },
            {
              params: { access_token: accessToken },
            }
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
