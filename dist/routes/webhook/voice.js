"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.post('/', (req, res) => {
    console.log("✅ Entró al webhook de voz");
    res.type('text/plain').send("🟢 Webhook de voz activo");
});
exports.default = router;
