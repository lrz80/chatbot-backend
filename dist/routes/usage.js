"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
router.get('/', async (req, res) => {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const tenantRes = await db_1.default.query('SELECT used, limite_uso, plan FROM tenants WHERE admin_uid = $1', [decoded.uid]);
        if (tenantRes.rows.length === 0) {
            return res.status(200).json({ used: 0, limit: 0, porcentaje: 0, plan: "free" });
        }
        const { used, limite_uso, plan } = tenantRes.rows[0];
        const porcentaje = limite_uso > 0 ? Math.round((used / limite_uso) * 100) : 0;
        return res.status(200).json({
            used: used || 0,
            limit: limite_uso || 0,
            porcentaje,
            plan: plan || "free",
        });
    }
    catch (error) {
        console.error('❌ Error en /usage:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
