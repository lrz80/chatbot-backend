"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// 📁 src/routes/unsubscribe.ts
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../lib/db"));
const router = express_1.default.Router();
router.get("/unsubscribe", async (req, res) => {
    const { email, tenant } = req.query;
    if (!email || !tenant) {
        return res.status(400).send("Faltan parámetros obligatorios.");
    }
    try {
        const result = await db_1.default.query(`INSERT INTO unsubscribed_emails (tenant_id, email, fecha) 
       VALUES ($1, $2, NOW()) 
       ON CONFLICT (tenant_id, email) DO NOTHING`, [tenant, email]);
        res.send(`
      <html>
        <head>
          <title>Suscripción cancelada</title>
        </head>
        <body style="font-family:Arial,sans-serif; text-align:center; padding:40px;">
          <h2>🛑 Has cancelado tu suscripción</h2>
          <p>Ya no recibirás más correos de este remitente.</p>
        </body>
      </html>
    `);
    }
    catch (err) {
        console.error("❌ Error al cancelar suscripción:", err);
        res.status(500).send("Error al cancelar suscripción.");
    }
});
exports.default = router;
