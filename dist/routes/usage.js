"use strict";
// 📁 src/routes/usage.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
router.get('/', (req, res) => {
    (async () => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Token requerido' });
            return;
        }
        try {
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            const result = await db_1.default.query('SELECT used, limit, porcentaje, plan FROM usage_limits WHERE uid = $1', [decoded.uid]);
            if (result.rows.length === 0) {
                return res.status(200).json({ used: 0, limit: 0, porcentaje: 0, plan: "free" });
            }
            return res.status(200).json(result.rows[0]);
        }
        catch (error) {
            console.error('❌ Error en /usage:', error);
            return res.status(500).json({ error: 'Error interno del servidor' });
        }
    })();
});
exports.default = router;
