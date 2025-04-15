"use strict";
// 📁 src/routes/auth.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = __importDefault(require("../lib/db"));
const uuid_1 = require("uuid");
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
// ✅ Registro
router.post('/register', async (req, res) => {
    const { nombre, apellido, email, telefono, password } = req.body;
    if (!nombre || !apellido || !email || !telefono || !password) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    try {
        const exists = await db_1.default.query('SELECT * FROM users WHERE email = $1', [email]);
        if (exists.rows.length > 0) {
            return res.status(409).json({ error: 'El correo ya está registrado' });
        }
        const password_hash = await bcryptjs_1.default.hash(password, 10);
        const uid = (0, uuid_1.v4)();
        const owner_name = `${nombre} ${apellido}`;
        await db_1.default.query(`INSERT INTO users (uid, email, password, role, owner_name, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`, [uid, email, password_hash, 'admin', owner_name]);
        const token = jsonwebtoken_1.default.sign({ uid, email }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // ⚠️ para cookies cross-domain
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        res.status(201).json({ uid });
    }
    catch (error) {
        console.error('❌ Error en registro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// ✅ Login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Correo y contraseña requeridos' });
    }
    try {
        const result = await db_1.default.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        const match = await bcryptjs_1.default.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        const token = jsonwebtoken_1.default.sign({ uid: user.uid, email: user.email }, JWT_SECRET, {
            expiresIn: '7d',
        });
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        res.status(200).json({ uid: user.uid });
    }
    catch (error) {
        console.error('❌ Error en login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
// ✅ Validar sesión
router.post('/validate', async (req, res) => {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ error: 'Token no encontrado' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        res.status(200).json({ uid: decoded.uid, email: decoded.email });
    }
    catch (error) {
        console.error('❌ Token inválido:', error);
        res.status(401).json({ error: 'Token inválido' });
    }
});
exports.default = router;
