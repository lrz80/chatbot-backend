"use strict";
// 📁 src/routes/jobs/send-scheduled-now.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../../middleware/auth");
const router = express_1.default.Router();
// 🚫 Eliminado el job manual para que sólo trabaje el Worker
router.post('/', auth_1.authenticateUser, async (req, res) => {
    res.status(200).json({
        success: false,
        message: 'El envío de mensajes programados ahora es automático mediante Worker.'
    });
});
exports.default = router;
