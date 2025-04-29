"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../../middleware/auth");
const db_1 = __importDefault(require("../../lib/db"));
const router = express_1.default.Router();
// 📥 Obtener mensajes de seguimiento ya enviados
router.get('/', auth_1.authenticateUser, async (req, res) => {
    try {
        const tenant_id = req.user?.tenant_id;
        if (!tenant_id)
            return res.status(401).json({ error: 'Tenant no autenticado' });
        const { rows: mensajes } = await db_1.default.query(`SELECT id, contacto, contenido, fecha_envio
       FROM mensajes_programados
       WHERE tenant_id = $1 AND enviado = true
       ORDER BY fecha_envio DESC
       LIMIT 100`, [tenant_id]);
        res.status(200).json(mensajes);
    }
    catch (error) {
        console.error('❌ Error en GET /follow-up/sent-messages:', error);
        res.status(500).json({ error: 'Error al obtener mensajes enviados' });
    }
});
exports.default = router;
