"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/preview-email.ts
const express_1 = __importDefault(require("express"));
const email_html_1 = require("../utils/email-html");
const router = express_1.default.Router();
router.post("/", (req, res) => {
    const { contenido, nombreNegocio, imagenUrl, linkUrl, logoUrl, email, tenantId, nombreContacto, asunto, tituloVisual, } = req.body;
    try {
        const html = (0, email_html_1.generarHTMLCorreo)(contenido, nombreNegocio, imagenUrl, linkUrl, logoUrl, email, tenantId, nombreContacto, asunto, tituloVisual);
        return res.send(html);
    }
    catch (err) {
        console.error("❌ Error generando preview:", err);
        return res.status(500).send("Error generando preview.");
    }
});
exports.default = router;
