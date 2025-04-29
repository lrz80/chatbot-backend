"use strict";
// chatbot-backend/src/app.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const body_parser_1 = __importDefault(require("body-parser"));
const dotenv_1 = __importDefault(require("dotenv"));
// Rutas principales
const auth_1 = __importDefault(require("./routes/auth"));
const settings_1 = __importDefault(require("./routes/settings"));
const tenants_1 = __importDefault(require("./routes/tenants"));
const prompt_1 = __importDefault(require("./routes/prompt"));
const voice_config_1 = __importDefault(require("./routes/voice-config"));
const keywords_1 = __importDefault(require("./routes/keywords"));
const usage_1 = __importDefault(require("./routes/usage"));
const stats_monthly_1 = __importDefault(require("./routes/stats-monthly"));
const whatsapp_1 = __importDefault(require("./routes/webhook/whatsapp"));
const sms_1 = __importDefault(require("./routes/webhook/sms"));
const voice_response_1 = __importDefault(require("./routes/webhook/voice-response"));
const messages_1 = __importDefault(require("./routes/messages"));
const generar_prompt_1 = __importDefault(require("./routes/generar-prompt"));
const preview_1 = __importDefault(require("./routes/preview"));
const faq_1 = __importDefault(require("./routes/faq"));
const intents_1 = __importDefault(require("./routes/intents"));
const verify_1 = __importDefault(require("./routes/verify"));
const forgot_password_1 = __importDefault(require("./routes/auth/forgot-password"));
const checkout_1 = __importDefault(require("./routes/stripe/checkout"));
const webhook_1 = __importDefault(require("./routes/stripe/webhook")); // 👈 Este debe ir ANTES del json
const flows_1 = __importDefault(require("./routes/flows"));
const stats_kpis_1 = __importDefault(require("./routes/stats-kpis"));
const upload_logo_1 = __importDefault(require("./routes/upload-logo"));
const campaigns_1 = __importDefault(require("./routes/campaigns"));
const upload_1 = __importDefault(require("./routes/contactos/upload"));
const delete_1 = __importDefault(require("./routes/contactos/delete"));
const count_1 = __importDefault(require("./routes/contactos/count"));
const voice_prompt_1 = __importDefault(require("./routes/voice-prompt"));
const voice_1 = __importDefault(require("./routes/webhook/voice"));
const test_1 = __importDefault(require("./routes/test"));
const leads_1 = __importDefault(require("./routes/sales-intelligence/leads"));
const follow_up_settings_1 = __importDefault(require("./routes/follow-up-settings"));
const sendScheduledMessages_1 = require("./jobs/sendScheduledMessages");
const send_scheduled_now_1 = __importDefault(require("./routes/jobs/send-scheduled-now"));
const sentMessages_1 = __importDefault(require("./routes/follow-up/sentMessages"));
const oauth_callback_1 = __importDefault(require("./routes/facebook/oauth-callback"));
const webhook_2 = __importDefault(require("./routes/facebook/webhook"));
console.log("🔁 Versión redeployada manualmente");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// ✅ Lista blanca de dominios
const allowedOrigins = [
    'http://localhost:3000',
    'https://www.aamy.ai',
];
// ✅ CORS middleware
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, origin);
        }
        else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));
// ✅ Webhook Stripe primero (usa body raw, no json)
app.use('/api/stripe/webhook', body_parser_1.default.raw({ type: 'application/json' }), webhook_1.default);
// ✅ Middlewares globales
app.use(express_1.default.json()); // después del webhook para no interferir
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
// ✅ Rutas
app.use('/auth', auth_1.default);
app.use('/api/settings', settings_1.default);
app.use('/api/tenants', tenants_1.default);
app.use('/api/prompt', prompt_1.default);
app.use("/api/voice-config", voice_config_1.default);
app.use('/api/keywords', keywords_1.default);
app.use('/api/usage', usage_1.default);
app.use('/api/stats/monthly', stats_monthly_1.default);
app.use('/webhook/whatsapp', whatsapp_1.default);
app.use('/webhook/sms', sms_1.default);
app.use('/webhook/voice-response', voice_response_1.default);
app.use('/api/messages', messages_1.default);
app.use('/api/generar-prompt', generar_prompt_1.default);
app.use('/api/preview', preview_1.default);
app.use('/api/faq', faq_1.default);
app.use('/api/intents', intents_1.default);
app.use('/api/verify', verify_1.default);
app.use(forgot_password_1.default);
app.use('/api/stripe', checkout_1.default); // otras rutas de Stripe (no webhook)
app.use('/api/flows', flows_1.default);
app.use('/api/stats', stats_kpis_1.default);
app.use('/api/upload-logo', upload_logo_1.default);
app.use('/uploads', express_1.default.static('uploads'));
app.use("/api/campaigns", campaigns_1.default);
app.use("/api/contactos", upload_1.default);
app.use("/api/contactos", delete_1.default);
app.use("/api/contactos/count", count_1.default);
app.use("/api/voice-prompt", voice_prompt_1.default);
app.use("/api/webhooks/voice", voice_1.default);
app.use("/api/test", test_1.default);
app.use('/api/sales-intelligence/leads', leads_1.default);
app.use('/api/follow-up-settings', follow_up_settings_1.default);
app.use('/api/jobs/send-scheduled-now', send_scheduled_now_1.default);
app.use('/api/follow-up/sent-messages', sentMessages_1.default);
app.use(oauth_callback_1.default);
app.use(webhook_2.default);
// ✅ Ruta base
app.get('/', (req, res) => {
    res.send('Backend corriendo 🟢');
});
// ✅ Ping para mantener Railway activo
setInterval(() => {
    fetch('https://api.aamy.ai/')
        .then(() => console.log('🔁 Ping enviado a backend'))
        .catch(() => console.warn('⚠️ Ping fallido'));
}, 1000 * 30);
setInterval(() => {
    (0, sendScheduledMessages_1.sendScheduledMessages)();
}, 60000); // cada 60 segundos
// ✅ Levantar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
