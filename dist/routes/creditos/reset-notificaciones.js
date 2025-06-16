"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
// Endpoint para reiniciar flags notificado_80 y notificado_100 al comprar créditos
router.post('/reset-notificaciones', async (req, res) => {
    try {
        const { tenant_id, canal, fecha_compra } = req.body;
        if (!tenant_id || !canal || !fecha_compra) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos (tenant_id, canal, fecha_compra)' });
        }
        await db_1.default.query(`
      UPDATE uso_mensual
      SET notificado_80 = FALSE, notificado_100 = FALSE
      WHERE tenant_id = $1 AND canal = $2 AND mes >= $3
    `, [tenant_id, canal, fecha_compra]);
        console.log(`🔄 Flags reiniciados para ${tenant_id} - ${canal} desde ${fecha_compra}`);
        res.status(200).json({ message: 'Flags reiniciados correctamente.' });
    }
    catch (error) {
        console.error('❌ Error al reiniciar flags:', error);
        res.status(500).json({ error: 'Error interno.' });
    }
});
exports.default = router;
