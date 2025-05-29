"use strict";
// src/routes/email-status/index.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../../lib/db"));
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
router.get("/", auth_1.authenticateUser, async (req, res) => {
    const { tenant_id } = req.user;
    const { campaign_id } = req.query;
    try {
        let query = `
  SELECT email, status, error_message, timestamp
  FROM email_status_logs
  WHERE tenant_id = $1
`;
        const params = [tenant_id];
        if (campaign_id) {
            query += " AND campaign_id = $2";
            params.push(Number(campaign_id));
        }
        query += " ORDER BY timestamp DESC LIMIT 100";
        const result = await db_1.default.query(query, params);
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Error obteniendo logs de email:", err);
        res.status(500).json({ error: "Error obteniendo logs" });
    }
});
exports.default = router;
