import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import { getRespuestaCompleta } from '../../lib/getRespuestaCompleta';

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

    if (body.object !== 'page') {
      return res.sendStatus(404);
    }

    for (const entry of body.entry) {
      const pageId = entry.id;

      for (const messagingEvent of entry.messaging) {
        const senderId = messagingEvent.sender.id;

        if (messagingEvent.message && !messagingEvent.message.is_echo) {
          const userMessage = messagingEvent.message.text || '';

          console.log('📩 Mensaje recibido:', userMessage);

          // 🔍 Buscar tenant por Facebook Page ID
          const tenantRes = await pool.query(
            'SELECT * FROM tenants WHERE facebook_page_id = $1 LIMIT 1',
            [pageId]
          );

          if (tenantRes.rows.length === 0) {
            console.error('❌ No se encontró tenant para page_id:', pageId);
            continue;
          }

          const tenant = tenantRes.rows[0];
          const tenantId = tenant.id;
          const accessToken = tenant.facebook_access_token;

          const respuestaFinal = await getRespuestaCompleta({
            canal: 'facebook',
            tenant,
            input: userMessage,
          });

          // 💾 Guardar mensaje del cliente
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
             VALUES ($1, 'user', $2, NOW(), 'facebook', $3)`,
            [tenantId, userMessage, senderId]
          );

          // 💾 Guardar respuesta del bot
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
             VALUES ($1, 'bot', $2, NOW(), 'facebook')`,
            [tenantId, respuestaFinal]
          );

          // 💾 Guardar interacción
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, created_at)
             VALUES ($1, 'facebook', NOW())`,
            [tenantId]
          );

          // ✅ Enviar respuesta
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

          console.log('✅ Respuesta enviada y guardada');
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
