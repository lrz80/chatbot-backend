import { Router } from 'express';
const router = Router();

router.post('/', (req, res) => {
  console.log("✅ Recibido POST en /api/test");
  res.send("🟢 Ruta POST /api/test activa");
});

export default router;
