"use strict";
// src/routes/auth/resend-code.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const email_smtp_1 = require("../../lib/senders/email-smtp");
const router = express_1.default.Router();
router.post("/auth/resend-code", async (req, res) => {
    const { email } = req.body;
    if (!email)
        return res.status(400).json({ error: "Correo requerido" });
    try {
        const userRes = await db_1.default.query("SELECT * FROM users WHERE email = $1", [email]);
        const user = userRes.rows[0];
        if (!user)
            return res.status(404).json({ error: "Usuario no encontrado" });
        if (user.verificado)
            return res.status(400).json({ error: "La cuenta ya está verificada" });
        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        await db_1.default.query("UPDATE users SET codigo_verificacion = $1 WHERE email = $2", [newCode, email]);
        await (0, email_smtp_1.sendVerificationEmail)(email, newCode);
        return res.status(200).json({ success: true });
    }
    catch (err) {
        console.error("❌ Error en /auth/resend-code:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
});
exports.default = router;
