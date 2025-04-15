"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
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
    (() => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const token = (_a = req.headers.authorization) === null || _a === void 0 ? void 0 : _a.split(' ')[1];
        if (!token)
            return res.status(401).json({ error: 'Token requerido' });
        try {
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            const result = yield db_1.default.query(`SELECT COUNT(*)::int AS total,
                COUNT(DISTINCT phone) AS usuarios,
                EXTRACT(HOUR FROM timestamp) AS hora_pico
         FROM interactions
         WHERE uid = $1
         GROUP BY hora_pico
         ORDER BY COUNT(*) DESC
         LIMIT 1`, [decoded.uid]);
            const { total, usuarios, hora_pico } = result.rows[0] || {
                total: 0,
                usuarios: 0,
                hora_pico: null,
            };
            return res.status(200).json({ total, usuarios, hora_pico });
        }
        catch (error) {
            console.error('❌ Error en /stats/kpis:', error);
            return res.status(500).json({ error: 'Error interno del servidor' });
        }
    }))();
});
exports.default = router;
