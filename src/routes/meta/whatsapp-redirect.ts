import { Router, Request, Response } from "express";

const router = Router();

/**
 * GET /meta/whatsapp-redirect
 *
 * Este endpoint NO debe hacer exchange del code.
 * Solo recibe code/state, los devuelve al frontend (window.opener) y cierra el popup.
 *
 * Motivo:
 * - El exchange real se hace en tu backend con POST /api/meta/whatsapp/exchange-code
 * - Evita redirect_uri mismatch y evita exponer access_token en URL
 */
router.get("/meta/whatsapp-redirect", async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";
  const errorReason =
    typeof req.query.error_reason === "string" ? req.query.error_reason : "";
  const errorDescription =
    typeof req.query.error_description === "string"
      ? req.query.error_description
      : "";

  console.log("📩 [WA REDIRECT] callback desde Meta:", {
    hasCode: !!code,
    state,
    error,
    errorReason,
    errorDescription,
  });

  // Si no hay code, devolvemos HTML que notifica error al opener
  const payload = code
    ? { type: "WA_EMBEDDED_SIGNUP_CODE", code, state }
    : {
        type: "WA_EMBEDDED_SIGNUP_ERROR",
        state,
        error: error || "missing_code",
        errorReason,
        errorDescription,
      };

  // HTML mínimo: postMessage al opener y cerrar
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WhatsApp Redirect</title>
  </head>
  <body>
    <script>
      (function () {
        try {
          var payload = ${JSON.stringify(payload)};
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, "*");
          }
        } catch (e) {}
        window.close();
      })();
    </script>
    <p>Finalizando conexión… Puedes cerrar esta ventana.</p>
  </body>
</html>`);
});

export default router;
