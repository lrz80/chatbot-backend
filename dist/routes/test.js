"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.post('/', (req, res) => {
    console.log("✅ Recibido POST en /api/test");
    res.send("🟢 Ruta POST /api/test activa");
});
exports.default = router;
