// 📁 src/routes/jobs/send-scheduled-now.ts

import express from 'express';
import { authenticateUser } from '../../middleware/auth';

const router = express.Router();

// 🚫 Eliminado el job manual para que sólo trabaje el Worker
router.post('/', authenticateUser, async (req, res) => {
  res.status(200).json({ 
    success: false, 
    message: 'El envío de mensajes programados ahora es automático mediante Worker.' 
  });
});

export default router;
