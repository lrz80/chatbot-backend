"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const router = express_1.default.Router();
const JWT_SECRET = process.env.JWT_SECRET || "recovery-secret";
router.post("/auth/reset-password", async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
        return res.status(400).json({ error: "Token y nueva contraseña requeridos" });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const { email } = decoded;
        const hashedPassword = await bcryptjs_1.default.hash(newPassword, 10);
        await db_1.default.query("UPDATE users SET password = $1 WHERE email = $2", [hashedPassword, email]);
        return res.status(200).json({ success: true });
    }
    catch (err) {
        console.error("❌ Error en /auth/reset-password:", err);
        return res.status(401).json({ error: "Token inválido o expirado" });
    }
});
exports.default = router;
