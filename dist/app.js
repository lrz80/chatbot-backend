"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// 📁 src/app.ts
const express_1 = __importDefault(require("express"));
const cors = require('cors'); // ✅ compatible con TypeScript sin errores
const dotenv_1 = __importDefault(require("dotenv"));
const auth_1 = __importDefault(require("./routes/auth"));
const settings_1 = __importDefault(require("./routes/settings"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use(cors());
app.use(express_1.default.json());
app.use('/auth', auth_1.default);
app.use('/api/settings', settings_1.default);
const PORT = process.env.PORT || 8080;
app.get('/', (req, res) => {
    res.send('✅ Backend activo');
});
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
setInterval(() => {
    globalThis
        .fetch(SELF_URL)
        .then(() => console.log('🔁 Keep-alive ping enviado'))
        .catch(err => console.error('⚠️ Error al hacer ping interno:', err.message));
}, 1000 * 60 * 4); // Cada 4 minutos
