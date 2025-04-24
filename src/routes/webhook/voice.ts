import { Router } from 'express';
import { twiml } from 'twilio';

const router = Router();

router.post('/', (req, res) => {
  console.log("📞 Webhook de voz Twilio recibido");

  const response = new twiml.VoiceResponse();
  response.say("Hola, gracias por llamar. ¿En qué puedo ayudarte?");
  response.pause({ length: 1 });
  response.hangup();

  res.type('text/xml');
  res.send(response.toString());
});

export default router;
