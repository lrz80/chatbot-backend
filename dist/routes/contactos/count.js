"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
router.get("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    try {
        const result = await db_1.default.query("SELECT COUNT(*) FROM contactos WHERE tenant_id = $1", [tenant_id]);
        const total = Number(result.rows[0].count);
        res.json({ total });
    }
    catch (err) {
        console.error("❌ Error al contar contactos:", err);
        res.status(500).json({ error: "Error al contar contactos" });
    }
});
exports.default = router;
