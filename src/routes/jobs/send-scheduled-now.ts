// 📁 src/routes/jobs/send-scheduled-now.ts

import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import { sendScheduledMessages } from '../../jobs/sendScheduledMessages';

const router = express.Router();

// 📥 Endpoint para ejecutar manualmente el envío de mensajes programados
router.post('/', authenticateUser, async (req, res) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      console.error('❌ No se encontraron las variables TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN.');
      return res.status(500).json({ success: false, error: 'Variables de Twilio no configuradas.' });
    }

    await sendScheduledMessages(accountSid, authToken);

    res.status(200).json({ success: true, message: 'Job ejecutado manualmente 🚀' });
  } catch (error) {
    console.error('❌ Error ejecutando job manual:', error);
    res.status(500).json({ success: false, error: 'Error ejecutando el job' });
  }
});

export default router;

