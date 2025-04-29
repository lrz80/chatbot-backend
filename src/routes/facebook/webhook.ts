// backend/src/routes/facebook/webhook.ts
import express from 'express';
import axios from 'axios';
import pool from '../../lib/db'; // Ajusta si tu conexión es diferente
import OpenAI from 'openai'; // Si quieres usar OpenAI para procesar el prompt (opcional)

const router = express.Router();

// Configura tu instancia de OpenAI si quieres respuestas inteligentes
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const mensajeDefault = 'Lo siento, no tengo una respuesta para eso en este momento.';

// Verificación de Webhook
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

// Mensajes entrantes
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

          // 1. Buscar el tenant por page_id
          const { rows } = await pool.query(
            'SELECT facebook_access_token, prompt_meta, bienvenida_meta, horario_atencion FROM tenants WHERE facebook_page_id = $1 LIMIT 1',
            [pageId]
          );

          if (rows.length === 0) {
            console.error('❌ No se encontró tenant para page_id:', pageId);
            continue;
          }

          const tenant = rows[0];
          const faqsRes = await pool.query('SELECT * FROM faqs WHERE tenant_id = $1', [tenant.id]);
          const intentsRes = await pool.query('SELECT * FROM intents WHERE tenant_id = $1', [tenant.id]);

          const accessToken = tenant.facebook_access_token;
          const bienvenidaMeta = tenant.bienvenida_meta || '¡Hola! Bienvenido.';
          const faqList = faqsRes.rows || [];
          const intentsList = intentsRes.rows || [];


          let respuestaFinal = bienvenidaMeta;

          // 2. Opcional: Detectar si está fuera de horario
          // (Aquí podrías validar horarioAtencion para mandar fuera de horario)

          // 3. Buscar coincidencias en FAQs o Intents
          const lowerMessage = userMessage.toLowerCase();

          const faqMatch = faqList.find((item: any) => lowerMessage.includes(item.pregunta.toLowerCase()));
          if (faqMatch) {
            respuestaFinal = faqMatch.respuesta;
          }

          const intentMatch = intentsList.find((intent: any) =>
            intent.ejemplos.some((ejemplo: string) => lowerMessage.includes(ejemplo.toLowerCase()))
          );
          if (intentMatch) {
            respuestaFinal = intentMatch.respuesta;
          }

          // 4. (Opcional) Si quieres que OpenAI lo responda si no encuentra coincidencias
          if (!faqMatch && !intentMatch && tenant.prompt_meta) {
            const openaiResponse = await openai.chat.completions.create({
              model: 'gpt-4',
              messages: [
                { role: 'system', content: tenant.prompt_meta },
                { role: 'user', content: userMessage },
              ],
              max_tokens: 300,
            });

            const aiText = openaiResponse.choices[0].message.content?.trim();
            respuestaFinal = aiText || mensajeDefault;
          }

          // 5. Enviar respuesta
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
