import express from 'express';
import pool from '../../lib/db';

const router = express.Router();

// Endpoint para reiniciar flags notificado_80 y notificado_100 al comprar créditos
router.post('/reset-notificaciones', async (req, res) => {
  try {
    const { tenant_id, canal, fecha_compra } = req.body;

    if (!tenant_id || !canal || !fecha_compra) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos (tenant_id, canal, fecha_compra)' });
    }

    await pool.query(`
      UPDATE uso_mensual
      SET notificado_80 = FALSE, notificado_100 = FALSE
      WHERE tenant_id = $1 AND canal = $2 AND mes >= $3
    `, [tenant_id, canal, fecha_compra]);

    console.log(`🔄 Flags reiniciados para ${tenant_id} - ${canal} desde ${fecha_compra}`);
    res.status(200).json({ message: 'Flags reiniciados correctamente.' });
  } catch (error) {
    console.error('❌ Error al reiniciar flags:', error);
    res.status(500).json({ error: 'Error interno.' });
  }
});

export default router;
