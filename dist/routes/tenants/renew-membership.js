"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
// Endpoint para renovar membresía y actualizar mes en uso_mensual
router.post('/renew-membership', async (req, res) => {
    try {
        const { tenant_id, nueva_membresia_inicio, nueva_membresia_vigencia } = req.body;
        if (!tenant_id || !nueva_membresia_inicio || !nueva_membresia_vigencia) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos (tenant_id, nueva_membresia_inicio, nueva_membresia_vigencia)' });
        }
        // 🔄 1. Actualizar membresía_inicio y membresía_vigencia
        await db_1.default.query(`
      UPDATE tenants
      SET membresia_inicio = $1, membresia_vigencia = $2, membresia_activa = true
      WHERE id = $3
    `, [nueva_membresia_inicio, nueva_membresia_vigencia, tenant_id]);
        console.log(`✅ membresia_inicio y vigencia actualizadas para ${tenant_id}`);
        // 🔄 2. Reiniciar uso_mensual.mes con nueva membresia_inicio
        const result = await db_1.default.query(`
      UPDATE uso_mensual
      SET mes = $1, usados = 0, notificado_80 = false, notificado_100 = false
      WHERE tenant_id = $2 AND mes < $1
    `, [nueva_membresia_inicio, tenant_id]);
        console.log(`🔄 mes actualizado en uso_mensual para ${tenant_id}. Registros: ${result.rowCount}`);
        res.status(200).json({ message: `Membresía y uso_mensual actualizados para ${tenant_id}` });
    }
    catch (error) {
        console.error('❌ Error al renovar membresía:', error);
        res.status(500).json({ error: 'Error interno.' });
    }
});
exports.default = router;
