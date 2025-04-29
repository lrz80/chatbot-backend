// backend/src/routes/facebook/webhook.ts
import express from 'express';
import axios from 'axios';
import pool from '../../lib/db'; // ⚡ Ajusta si tu conexión a DB es diferente

const router = express.Router();

// Ruta pública, Facebook validará este webhook
router.get('/api/facebook/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'testtoken';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook de Facebook verificado');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// Ruta para recibir mensajes entrantes
router.post('/api/facebook/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== 'page') {
      return res.sendStatus(404);
    }

    for (const entry of body.entry) {
      const pageId = entry.id; // ID de la página que recibió el mensaje

      for (const messagingEvent of entry.messaging) {
        const senderId = messagingEvent.sender.id;

        if (messagingEvent.message && !messagingEvent.message.is_echo) {
          console.log('📩 Mensaje recibido:', messagingEvent.message.text);

          // 1. Buscar el tenant basado en el pageId
          const { rows } = await pool.query(
            'SELECT facebook_access_token, facebook_mensaje_bienvenida, facebook_mensaje_default FROM tenants WHERE facebook_page_id = $1 LIMIT 1',
            [pageId]
          );

          if (rows.length === 0) {
            console.error('❌ No se encontró tenant para page_id:', pageId);
            return;
          }

          const tenant = rows[0];

          // 2. Preparar respuesta
          const reply = tenant.facebook_mensaje_bienvenida || tenant.facebook_mensaje_default || "¡Hola! ¿Cómo podemos ayudarte?";

          // 3. Responder al usuario
          await axios.post(
            `https://graph.facebook.com/v19.0/me/messages`,
            {
              recipient: { id: senderId },
              message: { text: reply },
            },
            {
              params: { access_token: tenant.facebook_access_token },
            }
          );

          console.log('✅ Respuesta enviada al usuario');
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
