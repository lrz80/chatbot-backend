"use strict";
// chatbot-backend/src/app.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
const voice_prompt_1 = __importDefault(require("./routes/voice-prompt"));
const voice_1 = __importDefault(require("./routes/webhook/voice"));
const test_1 = __importDefault(require("./routes/test"));
const leads_1 = __importDefault(require("./routes/sales-intelligence/leads"));
const follow_up_settings_1 = __importDefault(require("./routes/follow-up-settings"));
const send_scheduled_now_1 = __importDefault(require("./routes/jobs/send-scheduled-now"));
const sentMessages_1 = __importDefault(require("./routes/follow-up/sentMessages"));
const oauth_callback_1 = __importDefault(require("./routes/facebook/oauth-callback"));
const webhook_2 = __importDefault(require("./routes/facebook/webhook"));
const path = __importStar(require("path"));
const delete_1 = __importDefault(require("./routes/auth/delete"));
const voices_1 = __importDefault(require("./routes/elevenlabs/voices"));
const voice_links_1 = __importDefault(require("./routes/voice-links"));
const interacciones_por_dia_1 = __importDefault(require("./routes/stats/interacciones-por-dia"));
const usuarios_por_dia_1 = __importDefault(require("./routes/stats/usuarios-por-dia"));
const intenciones_por_dia_1 = __importDefault(require("./routes/stats/intenciones-por-dia"));
const hora_pico_1 = __importDefault(require("./routes/stats/hora-pico"));
const stats_1 = __importDefault(require("./routes/sales-intelligence/stats"));
const nuevos_1 = __importDefault(require("./routes/messages/nuevos"));
const index_1 = __importDefault(require("./routes/contactos/index"));
const sms_status_1 = __importDefault(require("./routes/webhook/sms-status"));
const checkout_credit_1 = __importDefault(require("./routes/stripe/checkout-credit"));
const limite_1 = __importDefault(require("./routes/contactos/limite"));
const templates_1 = __importDefault(require("./routes/sendgrid/templates"));
const index_2 = __importDefault(require("./routes/email-status/index"));
const preview_email_1 = __importDefault(require("./routes/preview-email"));
const cancel_1 = __importDefault(require("./routes/stripe/cancel"));
const reset_notificaciones_1 = __importDefault(require("./routes/creditos/reset-notificaciones"));
const renew_membership_1 = __importDefault(require("./routes/tenants/renew-membership"));
const meta_config_1 = __importDefault(require("./routes/meta-config"));
const conteo_1 = __importDefault(require("./routes/messages/conteo")); // ✅ nuevo
if (process.env.NODE_ENV !== 'production') {
    dotenv_1.default.config({ path: path.resolve(__dirname, '../.env.local') });
}
console.log("🔐 DATABASE_URL en arranque:", process.env.DATABASE_URL);
console.log('🔐 STRIPE KEY desde ENV:', process.env.STRIPE_SECRET_KEY);
console.log("🔁 Versión redeployada manualmente");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
app.use("/uploads", express_1.default.static(path.join(__dirname, "../public/uploads")));
console.log("📂 Servidor estático montado en:", path.join(__dirname, "../public/uploads"));
// ✅ Fallback universal para CORS en cualquier ruta
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://www.aamy.ai');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200); // respuesta inmediata a preflight
    }
    next();
});
// ✅ Lista blanca de dominios
const allowedOrigins = ['https://www.aamy.ai'];
// ✅ CORS middleware
app.use((0, cors_1.default)({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true); // ✅ esto SIEMPRE envía Access-Control-Allow-Origin
        }
        else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
}));
// ✅ Respuesta explícita a OPTIONS
app.options("*", (0, cors_1.default)({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error("Not allowed by CORS"));
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
app.use("/api/campaigns", campaigns_1.default);
app.use("/api/voice-prompt", voice_prompt_1.default);
app.use("/api/webhooks/voice", voice_1.default);
app.use("/api/test", test_1.default);
app.use('/api/sales-intelligence/leads', leads_1.default);
app.use('/api/follow-up-settings', follow_up_settings_1.default);
app.use('/api/jobs/send-scheduled-now', send_scheduled_now_1.default);
app.use('/api/follow-up/sent-messages', sentMessages_1.default);
app.use(oauth_callback_1.default);
app.use(webhook_2.default);
app.use('/api/delete-account', delete_1.default);
app.use('/api/elevenlabs/voices', voices_1.default);
app.use("/api/voice-links", voice_links_1.default);
app.use('/api/stats/interacciones-por-dia', interacciones_por_dia_1.default);
app.use('/api/stats/usuarios-por-dia', usuarios_por_dia_1.default);
app.use('/api/stats/intenciones-por-dia', intenciones_por_dia_1.default);
app.use('/api/stats/hora-pico', hora_pico_1.default);
app.use('/api/sales-intelligence/stats', stats_1.default);
app.use("/api/messages/nuevos", nuevos_1.default);
app.use("/api/contactos", index_1.default);
app.use("/api/webhook/sms-status", sms_status_1.default);
app.use('/api/stripe', checkout_credit_1.default);
app.use('/api/contactos/limite', limite_1.default);
app.use("/api/sendgrid/templates", templates_1.default);
app.use("/api/email-status", index_2.default);
app.use("/api/sendgrid/templates", templates_1.default);
app.use("/api/preview-email", preview_email_1.default);
app.use("/api/webhook/whatsapp", whatsapp_1.default);
app.use('/api/stripe/cancel', cancel_1.default);
app.use('/api/creditos', reset_notificaciones_1.default);
app.use('/api/tenants', renew_membership_1.default);
app.use('/api/meta-config', meta_config_1.default);
app.use('/api/messages/conteo', conteo_1.default); // ✅ activamos ruta
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
// ✅ Levantar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
