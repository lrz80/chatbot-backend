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
const nodemailer_1 = __importDefault(require("nodemailer"));
const mailer_1 = require("../lib/mailer");
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
// ✅ Transport para enviar emails
const transporter = nodemailer_1.default.createTransport({
    host: "mail.privateemail.com",
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_FROM,
        pass: process.env.EMAIL_PASS,
    },
});
// ✅ Registro corregido
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
        const token_verificacion = jsonwebtoken_1.default.sign({ uid, email }, JWT_SECRET, { expiresIn: '10m' });
        const verification_link = `${process.env.FRONTEND_URL}/auth/verify-email?token=${token_verificacion}`;
        console.log("🌐 Enlace de verificación:", verification_link);
        // ✅ Crear tenant antes del usuario
        await db_1.default.query(`INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, NOW())`, [uid, owner_name]);
        // ✅ Crear usuario con tenant_id
        await db_1.default.query(`INSERT INTO users (uid, tenant_id, email, password, role, owner_name, telefono, created_at, verificado, token_verificacion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), false, $8)`, [uid, uid, email, password_hash, 'admin', owner_name, telefono, token_verificacion]);
        await (0, mailer_1.sendVerificationEmail)(email, verification_link, 'es');
        res.status(201).json({ success: true });
    }
    catch (error) {
        console.error('❌ Error en registro:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.get("/verify-email", async (req, res) => {
    const token = req.query.token;
    if (!token) {
        return res.status(400).json({ error: "Token faltante" });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const userRes = await db_1.default.query("SELECT * FROM users WHERE uid = $1", [decoded.uid]);
        const user = userRes.rows[0];
        if (!user)
            return res.status(404).json({ error: "Usuario no encontrado" });
        if (user.verificado)
            return res.status(400).json({ error: "La cuenta ya está verificada" });
        await db_1.default.query("UPDATE users SET verificado = true, token_verificacion = NULL WHERE uid = $1", [decoded.uid]);
        // ✅ Redireccionar al frontend
        const baseUrl = process.env.FRONTEND_URL || "https://www.aamy.ai";
        res.redirect(`${process.env.FRONTEND_URL}/auth/verify-email?token=${token}`);
    }
    catch (err) {
        console.error("❌ Error al verificar email:", err);
        return res.status(400).json({ error: "Token inválido o expirado" });
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
        if (!user.verificado) {
            return res.status(403).json({ error: "Tu cuenta no está verificada. Revisa tu correo." });
        }
        const token = jsonwebtoken_1.default.sign({
            uid: user.uid,
            email: user.email,
            tenant_id: user.tenant_id || user.uid, // 👈 usa el uid como tenant_id si no hay campo separado
        }, JWT_SECRET, {
            expiresIn: '7d',
        });
        res.cookie('token', token, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            partitioned: true,
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        res.status(200).json({ uid: user.uid });
    }
    catch (error) {
        console.error('❌ Error en login:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
router.get('/debug-token', (req, res) => {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ error: '❌ No hay token en las cookies' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || 'secret-key');
        return res.status(200).json({ ok: true, decoded });
    }
    catch (err) {
        console.error('❌ Token inválido o expirado:', err);
        return res.status(401).json({ error: '❌ Token inválido o expirado', details: err });
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
