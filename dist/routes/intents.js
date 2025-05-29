"use strict";
// 📁 src/routes/intents.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
// ✅ GET: Obtener intenciones
router.get('/', auth_1.authenticateUser, async (req, res) => {
    const tenantId = req.user?.tenant_id;
    if (!tenantId)
        return res.status(401).json({ error: 'Tenant no autenticado' });
    try {
        const result = await db_1.default.query('SELECT nombre, ejemplos, respuesta FROM intents WHERE tenant_id = $1', [tenantId]);
        const intents = result.rows.map((i) => ({
            nombre: i.nombre,
            ejemplos: i.ejemplos,
            respuesta: i.respuesta,
        }));
        return res.status(200).json(intents);
    }
    catch (err) {
        console.error('❌ Error al obtener intenciones:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
// ✅ POST: Guardar intenciones con validación
router.post('/', auth_1.authenticateUser, async (req, res) => {
    const tenantId = req.user?.tenant_id;
    if (!tenantId)
        return res.status(401).json({ error: 'Tenant no autenticado' });
    try {
        const { intents } = req.body;
        // ✅ Validar que al menos una intención válida exista
        const intentsValidos = intents.filter((i) => i.nombre?.trim() &&
            Array.isArray(i.ejemplos) &&
            i.ejemplos.length > 0 &&
            i.respuesta?.trim());
        if (intentsValidos.length === 0) {
            return res.status(400).json({ error: 'No se recibieron intenciones válidas' });
        }
        // 🧹 Borrar las anteriores y guardar solo las válidas
        await db_1.default.query('DELETE FROM intents WHERE tenant_id = $1', [tenantId]);
        for (const intent of intentsValidos) {
            await db_1.default.query('INSERT INTO intents (tenant_id, nombre, ejemplos, respuesta) VALUES ($1, $2, $3, $4)', [tenantId, intent.nombre.trim(), intent.ejemplos, intent.respuesta.trim()]);
        }
        return res.status(200).json({ message: 'Intenciones actualizadas correctamente' });
    }
    catch (err) {
        console.error('❌ Error al guardar intenciones:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
exports.default = router;
