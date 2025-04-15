"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const auth_1 = __importDefault(require("./routes/auth"));
const settings_1 = __importDefault(require("./routes/settings")); // ✅ Importa el nuevo archivo
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
const allowedOrigins = [
    'http://localhost:3000',
    'https://www.aamy.ai',
];
// ✅ CORS middleware
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));
// ✅ Middlewares base
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
// ✅ Rutas
app.use('/auth', auth_1.default);
app.use('/api/settings', settings_1.default); // ✅ Ruta de settings agregada
// ✅ Ping de salud
app.get('/', (req, res) => {
    res.send('Backend corriendo 🟢');
});
// ✅ Servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
