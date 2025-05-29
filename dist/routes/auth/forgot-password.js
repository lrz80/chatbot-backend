"use strict";
// src/routes/auth/forgot-password.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const email_smtp_1 = require("../../lib/senders/email-smtp");
const router = express_1.default.Router();
const JWT_SECRET = process.env.JWT_SECRET || "recovery-secret";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.aamy.ai";
router.post("/auth/forgot-password", async (req, res) => {
    const { email } = req.body;
    if (!email)
        return res.status(400).json({ error: "Correo requerido" });
    try {
        const userRes = await db_1.default.query("SELECT id FROM users WHERE email = $1", [email]);
        if (userRes.rows.length === 0) {
            // No revelar si el email existe o no
            return res.status(200).json({ success: true });
        }
        const token = jsonwebtoken_1.default.sign({ email }, JWT_SECRET, { expiresIn: "15m" });
        const link = `${FRONTEND_URL}/reset-password?token=${token}`;
        await (0, email_smtp_1.sendPasswordResetEmail)(email, link);
        return res.status(200).json({ success: true });
    }
    catch (err) {
        console.error("❌ Error en /auth/forgot-password:", err);
        return res.status(500).json({ error: "Error interno del servidor" });
    }
});
exports.default = router;
