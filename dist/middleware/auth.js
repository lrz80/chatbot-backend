"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateUser = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../lib/db"));
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const authenticateUser = async (req, res, next) => {
    console.log("🔐 [AUTH] Ruta solicitada:", req.method, req.originalUrl);
    console.log("🔐 [AUTH] Cookie recibida:", req.cookies?.token ? "✅ Sí" : "❌ No");
    console.log("🔐 [AUTH] Header Authorization:", req.headers.authorization || "❌ No header");
    const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];
    if (!token) {
        console.warn("⚠️ Token no encontrado en cookies ni headers");
        return res.status(401).json({ error: "Token requerido" });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        console.log("✅ TOKEN DECODIFICADO:", decoded);
        // ✅ Buscar el tenant_id real desde la base de datos
        const result = await db_1.default.query("SELECT tenant_id FROM users WHERE uid = $1", [decoded.uid]);
        const user = result.rows[0];
        if (!user) {
            console.error("❌ Usuario no encontrado en la base de datos");
            return res.status(401).json({ error: "Usuario no encontrado" });
        }
        req.user = {
            uid: decoded.uid,
            tenant_id: user.tenant_id,
            email: decoded.email,
        };
        console.log("👤 req.user asignado:", req.user);
        next();
    }
    catch (err) {
        console.error("❌ Error al verificar token:", err);
        return res.status(403).json({ error: "Token inválido" });
    }
};
exports.authenticateUser = authenticateUser;
