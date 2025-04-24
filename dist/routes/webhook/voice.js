"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = require("twilio");
const router = (0, express_1.Router)();
router.post('/', (req, res) => {
    console.log("📞 Webhook de voz Twilio recibido");
    const response = new twilio_1.twiml.VoiceResponse();
    response.say("Hola, gracias por llamar. ¿En qué puedo ayudarte?");
    response.pause({ length: 1 });
    response.hangup();
    res.type('text/xml');
    res.send(response.toString());
});
exports.default = router;
