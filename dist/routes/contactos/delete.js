"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
router.delete("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    try {
        await db_1.default.query("DELETE FROM contactos WHERE tenant_id = $1", [tenant_id]);
        res.status(200).json({ ok: true, message: "Contactos eliminados correctamente." });
    }
    catch (err) {
        console.error("❌ Error al eliminar contactos:", err);
        res.status(500).json({ error: "Error al eliminar contactos" });
    }
});
exports.default = router;
