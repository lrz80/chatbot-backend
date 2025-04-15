"use strict";
// 📁 src/routes/settings.ts
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
        }
        try {
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            const userRes = await db_1.default.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
            const user = userRes.rows[0];
            if (!user) {
                return res.status(404).json({ error: 'Usuario no encontrado' });
            }
            return res.status(200).json({
                uid: user.uid,
                email: user.email,
                owner_name: user.owner_name,
            });
        }
        catch (error) {
            console.error('❌ Error en /settings:', error);
            return res.status(401).json({ error: 'Token inválido' });
        }
    })();
});
exports.default = router;
