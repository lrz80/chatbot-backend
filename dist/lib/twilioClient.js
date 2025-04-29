"use strict";
// 📁 src/lib/twilioClient.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTwilioClient = getTwilioClient;
const twilio_1 = __importDefault(require("twilio"));
function getTwilioClient() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        console.error('❌ Error: Faltan variables de Twilio (TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN)');
        throw new Error('Twilio no configurado correctamente');
    }
    return (0, twilio_1.default)(accountSid, authToken);
}
