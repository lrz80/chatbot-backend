"use strict";
// 📁 src/routes/verify.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const email_smtp_1 = require("../lib/senders/email-smtp");
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
router.post("/", async (req, res) => {
    const token = req.cookies?.token;
    const { codigo } = req.body;
    if (!token)
        return res.status(401).json({ error: "Token requerido" });
    if (!codigo)
        return res.status(400).json({ error: "Código requerido" });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const uid = decoded.uid;
        const userRes = await db_1.default.query("SELECT * FROM users WHERE uid = $1", [uid]);
        const user = userRes.rows[0];
        if (!user)
            return res.status(404).json({ error: "Usuario no encontrado" });
        if (user.codigo_verificacion !== codigo) {
            return res.status(401).json({ error: "Código incorrecto" });
        }
        await db_1.default.query("UPDATE users SET verificado = true, codigo_verificacion = NULL WHERE uid = $1", [uid]);
        // ✅ Notificar por email que su cuenta fue verificada correctamente
        const mensaje = `
      Tu correo ha sido verificado exitosamente ✅. Ya puedes acceder a todas las funciones de la plataforma.
    `;
        await (0, email_smtp_1.sendWelcomeEmail)(user.email);
        return res.status(200).json({ message: "Correo verificado exitosamente ✅" });
    }
    catch (err) {
        console.error("❌ Error al verificar código:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
});
exports.default = router;
