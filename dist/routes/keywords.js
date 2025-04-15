"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const router = express_1.default.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
router.get('/', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        res.status(401).json({ error: 'Token requerido' });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const result = await db_1.default.query(`SELECT word, count FROM keywords WHERE uid = $1 ORDER BY count DESC LIMIT 10`, [decoded.uid]);
        res.status(200).json({
            keywords: result.rows.map((row) => [row.word, row.count]),
        });
    }
    catch (error) {
        console.error('❌ Error en /keywords:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
exports.default = router;
