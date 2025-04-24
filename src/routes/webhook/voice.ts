import { Router } from 'express';

const router = Router();

router.post('/', (req, res) => {
  console.log("✅ Entró al webhook de voz");
  res.type('text/plain').send("🟢 Webhook de voz activo");
});

export default router;
