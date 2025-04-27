// src/routes/jobs/send-scheduled-now.ts

import express from 'express';
import { authenticateUser } from '../../middleware/auth';
import { sendScheduledMessages } from '../../jobs/sendScheduledMessages';

const router = express.Router();

router.post('/', authenticateUser, async (req, res) => {
  try {
    await sendScheduledMessages(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!
    );
    res.status(200).json({ success: true, message: 'Job ejecutado manualmente' });
  } catch (error) {
    console.error('❌ Error ejecutando job manual:', error);
    res.status(500).json({ success: false, error: 'Error ejecutando el job' });
  }
});

export default router;
