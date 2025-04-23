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
            ejemplos: i.ejemplos, // ya viene como array desde Postgres
            respuesta: i.respuesta,
        }));
        return res.status(200).json(intents);
    }
    catch (err) {
        console.error('❌ Error al obtener intenciones:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
// ✅ POST: Guardar intenciones
router.post('/', auth_1.authenticateUser, async (req, res) => {
    const tenantId = req.user?.tenant_id;
    if (!tenantId)
        return res.status(401).json({ error: 'Tenant no autenticado' });
    try {
        const { intents } = req.body;
        await db_1.default.query('DELETE FROM intents WHERE tenant_id = $1', [tenantId]);
        for (const intent of intents) {
            const ejemplosArray = Array.isArray(intent.ejemplos) ? intent.ejemplos : [];
            await db_1.default.query('INSERT INTO intents (tenant_id, nombre, ejemplos, respuesta) VALUES ($1, $2, $3, $4)', [tenantId, intent.nombre, ejemplosArray, intent.respuesta]);
        }
        return res.status(200).json({ message: 'Intenciones actualizadas' });
    }
    catch (err) {
        console.error('❌ Error al guardar intenciones:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});
exports.default = router;
