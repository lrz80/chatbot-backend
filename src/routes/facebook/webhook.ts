import express from 'express';
import axios from 'axios';
import pool from '../../lib/db';
import { getRespuestaCompleta } from '../../lib/getRespuestaCompleta';
import { incrementarUsoPorNumero } from '../../lib/incrementUsage';

const router = express.Router();

router.get('/api/facebook/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'testtoken';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook de Meta verificado');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
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
          console.log('📩 Mensaje recibido:', userMessage);

          const tenantRes = await pool.query(
            'SELECT * FROM tenants WHERE facebook_page_id = $1 OR instagram_page_id = $1 LIMIT 1',
            [pageId]
          );

          if (tenantRes.rows.length === 0) {
            console.error('❌ No se encontró tenant para page_id:', pageId);
            continue;
          }

          const tenant = tenantRes.rows[0];
          const tenantId = tenant.id;
          const canal = tenant.facebook_page_id === pageId ? 'facebook' : 'instagram';
          const accessToken = tenant.facebook_access_token;

          const respuestaFinal = await getRespuestaCompleta({
            canal,
            tenant,
            input: userMessage,
          });

          // Guardar mensaje del cliente
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number)
             VALUES ($1, 'user', $2, NOW(), $3, $4)`,
            [tenantId, userMessage, canal, senderId]
          );

          // Guardar mensaje del bot
          await pool.query(
            `INSERT INTO messages (tenant_id, sender, content, timestamp, canal)
             VALUES ($1, 'bot', $2, NOW(), $3)`,
            [tenantId, respuestaFinal, canal]
          );

          // Registrar interacción
          await pool.query(
            `INSERT INTO interactions (tenant_id, canal, created_at)
             VALUES ($1, $2, NOW())`,
            [tenantId, canal]
          );

          // Incrementar contador de uso
          await incrementarUsoPorNumero(senderId);

          // Enviar respuesta al usuario
          await axios.post(
            'https://graph.facebook.com/v19.0/me/messages',
            {
              recipient: { id: senderId },
              message: { text: respuestaFinal },
            },
            {
              params: { access_token: accessToken },
            }
          );

          console.log(`✅ Respuesta enviada por ${canal}`);
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error: any) {
    console.error('❌ Error en webhook Meta:', error.response?.data || error.message || error);
    res.sendStatus(500);
  }
});

export default router;
