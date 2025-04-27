import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import { sendScheduledMessages } from '../../jobs/sendScheduledMessages';

const router = express.Router();

// 📥 Endpoint para ejecutar manualmente el envío de mensajes programados
router.post('/', authenticateUser, async (req, res) => {
  try {
    await sendScheduledMessages();
    res.status(200).json({ success: true, message: 'Job ejecutado manualmente' });
  } catch (error) {
    console.error('❌ Error ejecutando job manual:', error);
    res.status(500).json({ success: false, error: 'Error ejecutando el job' });
  }
});

export default router;
