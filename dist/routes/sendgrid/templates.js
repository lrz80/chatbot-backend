"use strict";
// src/routes/sendgrid/templates.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const client_1 = __importDefault(require("@sendgrid/client"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
client_1.default.setApiKey(process.env.SENDGRID_API_KEY);
router.get("/", auth_1.authenticateUser, async (req, res) => {
    try {
        const [response, body] = await client_1.default.request({
            method: "GET",
            url: "/v3/templates",
        });
        const templates = (body?.templates || []).map((t) => ({
            id: t.id,
            name: t.name,
            updated_at: t.updated_at,
        }));
        return res.json(templates);
    }
    catch (error) {
        console.error("❌ Error al obtener plantillas de SendGrid:", error);
        return res.status(500).json({ error: "No se pudieron cargar las plantillas." });
    }
});
exports.default = router;
