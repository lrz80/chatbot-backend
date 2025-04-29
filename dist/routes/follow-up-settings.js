"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../lib/db"));
const router = express_1.default.Router();
// 📥 GET: Obtener configuración de seguimiento
router.get('/', auth_1.authenticateUser, async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    try {
        const result = await db_1.default.query(`SELECT * FROM follow_up_settings WHERE tenant_id = $1`, [tenant_id]);
        if (result.rows.length === 0) {
            return res.json(null); // No hay configuración todavía
        }
        res.json(result.rows[0]);
    }
    catch (error) {
        console.error('❌ Error obteniendo follow_up_settings:', error);
        res.status(500).json({ error: 'Error al obtener configuración' });
    }
});
// 🛠 POST: Crear o actualizar configuración de seguimiento
router.post('/', auth_1.authenticateUser, async (req, res) => {
    const tenant_id = req.user?.tenant_id;
    const { minutos_espera, mensaje_precio, mensaje_agendar, mensaje_ubicacion, mensaje_general, } = req.body;
    try {
        const existing = await db_1.default.query(`SELECT * FROM follow_up_settings WHERE tenant_id = $1`, [tenant_id]);
        if (existing.rows.length > 0) {
            // Ya existe: hacer UPDATE
            await db_1.default.query(`UPDATE follow_up_settings SET
          minutos_espera = $1,
          mensaje_precio = $2,
          mensaje_agendar = $3,
          mensaje_ubicacion = $4,
          mensaje_general = $5
         WHERE tenant_id = $6`, [
                minutos_espera,
                mensaje_precio,
                mensaje_agendar,
                mensaje_ubicacion,
                mensaje_general,
                tenant_id
            ]);
        }
        else {
            // No existe: hacer INSERT
            await db_1.default.query(`INSERT INTO follow_up_settings (
          tenant_id, minutos_espera, mensaje_precio, mensaje_agendar, mensaje_ubicacion, mensaje_general
        ) VALUES ($1, $2, $3, $4, $5, $6)`, [
                tenant_id,
                minutos_espera,
                mensaje_precio,
                mensaje_agendar,
                mensaje_ubicacion,
                mensaje_general,
            ]);
        }
        res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('❌ Error guardando follow_up_settings:', error);
        res.status(500).json({ error: 'Error al guardar configuración' });
    }
});
exports.default = router;
