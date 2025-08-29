// src/routes/faqs/index.ts
import { Router, Request, Response } from 'express';
import pool from '../../lib/db';
import { authenticateUser } from '../../middleware/auth';

const router = Router();

// 🔠 Función para capitalizar la primera letra de una oración
function capitalizar(texto: string): string {
  if (!texto) return '';
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// ✅ GET: Obtener FAQs
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    let canalQuery = req.query.canal;
    let canales: string[] = [];

    if (canalQuery === 'meta') {
      canales = ['meta', 'facebook', 'instagram']; // unificamos
    } else if (canalQuery) {
      canales = [canalQuery.toString()];
    } else {
      canales = ['whatsapp']; // por defecto
    }

const faqRes = await pool.query(
  'SELECT id, pregunta, respuesta, intencion, canal FROM faqs WHERE tenant_id = $1 AND canal = ANY($2)',
  [tenantId, `{${canales.join(',')}}`]
);


    return res.status(200).json(faqRes.rows);
  } catch (err) {
    console.error('❌ Error al obtener FAQ:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ✅ POST: Guardar FAQs con validación
router.post('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    const { faqs } = req.body;

    if (!tenantId) return res.status(404).json({ error: 'Negocio no encontrado' });

    // 🔒 Filtrar FAQs vacías
    const faqsFiltradas = (faqs || []).filter(
      (item: any) =>
        item.pregunta?.toString().trim() !== '' &&
        item.respuesta?.toString().trim() !== ''
    );

    if (faqsFiltradas.length === 0) {
      return res.status(400).json({ error: 'No se recibieron FAQs válidas' });
    }

    // 🧹 Eliminar FAQs previas del tenant
    await pool.query('DELETE FROM faqs WHERE tenant_id = $1', [tenantId]);

    // 💾 Insertar cada nueva FAQ
    for (const item of faqsFiltradas) {
      const preguntaOriginal = capitalizar(item.pregunta.toString().trim());
      const respuesta = item.respuesta.toString().trim();
      const intencion = item.intencion?.toString().trim().toLowerCase();

      if (!intencion) {
        console.warn(`⚠️ Pregunta "${preguntaOriginal}" no tiene intención definida. Saltando.`);
        continue; // ⚠️ No guardar FAQ sin intención válida
      }

      const canal = (item.canal === 'facebook' || item.canal === 'instagram') ? 'meta' : (item.canal || 'whatsapp');

      await pool.query(
        'INSERT INTO faqs (tenant_id, pregunta, respuesta, intencion, canal) VALUES ($1, $2, $3, $4, $5)',
        [tenantId, preguntaOriginal, respuesta, intencion, canal]
      );

    }

    return res.status(200).json({ message: 'FAQs actualizadas' });
  } catch (err) {
    console.error('❌ Error al guardar FAQ:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
