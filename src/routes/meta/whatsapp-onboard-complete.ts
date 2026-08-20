//src/routes/meta/whatsapp-onboard-complete.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import {
  subscribeAppToWaba,
  getSubscribedAppsFromWaba,
} from "../../lib/meta/whatsappSystemUser";
import { getProviderToken } from "../../lib/meta/getProviderToken";

const router = Router();

const APP_ID =
  process.env.META_APP_ID ||
  process.env.NEXT_PUBLIC_META_APP_ID ||
  "";

const GRAPH_VERSION =
  process.env.META_GRAPH_VERSION || "v26.0";

type PhoneNumberGraphResponse = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

async function getPhoneNumberDetails(
  phoneNumberId: string,
  accessToken: string
): Promise<PhoneNumberGraphResponse> {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/` +
    `${encodeURIComponent(phoneNumberId)}` +
    `?fields=id,display_phone_number,verified_name`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json =
    (await response.json().catch(() => ({}))) as PhoneNumberGraphResponse;

  if (!response.ok) {
    const graphMessage =
      json?.error?.message ||
      `Graph API respondió HTTP ${response.status}`;

    throw new Error(graphMessage);
  }

  return json;
}

router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;

      const tenantId: string | undefined =
        user?.tenant_id ||
        user?.tenantId;

      const wabaId: string | undefined =
        req.body?.wabaId ||
        req.body?.waba_id ||
        req.body?.whatsapp_business_id ||
        req.body?.business_id;

      const phoneNumberId: string | undefined =
        req.body?.phoneNumberId ||
        req.body?.phone_number_id ||
        req.body?.phoneNumberID ||
        req.body?.whatsapp_phone_number_id;

      console.log(
        "[WA ONBOARD COMPLETE] Body recibido:",
        {
          tenantId,
          wabaId,
          phoneNumberId,
        }
      );

      if (!tenantId) {
        return res.status(401).json({
          ok: false,
          error: "Tenant no identificado",
        });
      }

      if (!wabaId || !phoneNumberId) {
        return res.status(400).json({
          ok: false,
          error:
            "Faltan wabaId o phoneNumberId en el cuerpo",
          got: {
            wabaId,
            phoneNumberId,
          },
        });
      }

      /*
       * 1) Obtener access token del tenant.
       *
       * exchange-code debe haberlo guardado antes
       * de llegar a este endpoint.
       */
      const tokenResult = await pool.query(
        `
        SELECT whatsapp_access_token
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      if (!tokenResult.rowCount) {
        return res.status(404).json({
          ok: false,
          error: "Tenant no encontrado",
        });
      }

      const tenantAccessToken = String(
        tokenResult.rows[0]?.whatsapp_access_token || ""
      ).trim();

      /*
       * 2) Resolver número visible desde Graph.
       *
       * Este paso NO debe convertir una conexión válida
       * en fallida si Meta temporalmente no devuelve
       * display_phone_number.
       */
      let displayPhoneNumber: string | null = null;
      let verifiedName: string | null = null;

      if (!tenantAccessToken) {
        console.warn(
          "[WA ONBOARD COMPLETE] Tenant sin whatsapp_access_token. " +
            "Se continuará sin resolver display_phone_number."
        );
      } else {
        try {
          const phoneDetails =
            await getPhoneNumberDetails(
              phoneNumberId,
              tenantAccessToken
            );

          displayPhoneNumber =
            typeof phoneDetails?.display_phone_number ===
              "string" &&
            phoneDetails.display_phone_number.trim()
              ? phoneDetails.display_phone_number.trim()
              : null;

          verifiedName =
            typeof phoneDetails?.verified_name === "string" &&
            phoneDetails.verified_name.trim()
              ? phoneDetails.verified_name.trim()
              : null;

          console.log(
            "[WA ONBOARD COMPLETE] Phone details:",
            {
              phoneNumberId,
              displayPhoneNumber,
              verifiedName,
            }
          );
        } catch (error: any) {
          console.warn(
            "[WA ONBOARD COMPLETE] No se pudo resolver " +
              "display_phone_number:",
            error?.message || error
          );
        }
      }

      /*
       * 3) Guardar conexión.
       *
       * COALESCE evita borrar un número que ya estuviera
       * guardado si Graph falla temporalmente.
       */
      const update = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id       = $1,
          whatsapp_phone_number_id   = $2,
          whatsapp_phone_number      =
            COALESCE($3, whatsapp_phone_number),
          whatsapp_mode              = 'cloudapi',
          whatsapp_sender_sid        = NULL,
          whatsapp_status            = 'connected',
          whatsapp_connected         = TRUE,
          whatsapp_connected_at      = NOW(),
          updated_at                 = NOW()
        WHERE id::text = $4
        RETURNING
          id,
          name,
          whatsapp_business_id,
          whatsapp_phone_number_id,
          whatsapp_phone_number,
          whatsapp_mode,
          whatsapp_status,
          whatsapp_connected,
          whatsapp_connected_at;
        `,
        [
          wabaId,
          phoneNumberId,
          displayPhoneNumber,
          tenantId,
        ]
      );

      if (!update.rowCount) {
        return res.status(404).json({
          ok: false,
          error:
            "No se pudo actualizar el tenant después del onboarding",
        });
      }

      console.log(
        "[WA ONBOARD COMPLETE] Tenant actualizado:",
        update.rows[0]
      );

      /*
       * 4) Suscribir la app al WABA.
       *
       * Para esto sí usamos el Provider/System User token.
       */
      try {
        const providerToken = getProviderToken();

        if (!providerToken) {
          console.warn(
            "[WA ONBOARD COMPLETE] providerToken vacío. " +
              "No se pudo suscribir app al WABA."
          );
        } else {
          const sub = await subscribeAppToWaba(
            wabaId,
            providerToken
          );

          console.log(
            "[WA ONBOARD COMPLETE] subscribeAppToWaba OK:",
            sub
          );
        }
      } catch (error: any) {
        console.warn(
          "[WA ONBOARD COMPLETE] subscribeAppToWaba FAIL:",
          error?.message || error
        );
      }

      /*
       * 5) Confirmar subscribed_apps.
       *
       * Logging solamente. No rompe onboarding.
       */
      try {
        const providerToken = getProviderToken();

        if (!providerToken) {
          console.warn(
            "[WA ONBOARD COMPLETE] providerToken vacío. " +
              "No se pudo leer subscribed_apps."
          );
        } else {
          const apps =
            await getSubscribedAppsFromWaba(
              wabaId,
              providerToken
            );

          const list = Array.isArray(
            (apps as any)?.data
          )
            ? (apps as any).data
            : [];

          const isSubscribed =
            Boolean(APP_ID) &&
            list.some((app: any) => {
              const directId = app?.id;
              const nestedId =
                app?.whatsapp_business_api_data?.id;

              return (
                String(directId || "") ===
                  String(APP_ID) ||
                String(nestedId || "") ===
                  String(APP_ID)
              );
            });

          console.log(
            "[WA ONBOARD COMPLETE] subscribed_apps:",
            {
              appId: APP_ID || null,
              isSubscribed,
              appIds: list.map((app: any) => ({
                id: app?.id ?? null,
                nestedId:
                  app?.whatsapp_business_api_data?.id ??
                  null,
              })),
            }
          );

          if (!APP_ID) {
            console.warn(
              "[WA ONBOARD COMPLETE] META_APP_ID no configurado."
            );
          } else if (!isSubscribed) {
            console.error(
              "[WA ONBOARD COMPLETE] " +
                "La app no aparece en subscribed_apps del WABA."
            );
          }
        }
      } catch (error: any) {
        console.error(
          "[WA ONBOARD COMPLETE] Error leyendo subscribed_apps:",
          error?.message || error
        );
      }

      return res.json({
        ok: true,
        tenant: update.rows[0],
        phone: {
          phone_number_id: phoneNumberId,
          display_phone_number: displayPhoneNumber,
          verified_name: verifiedName,
        },
      });
    } catch (error: any) {
      console.error(
        "[WA ONBOARD COMPLETE] Error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          "Error interno guardando la conexión",
        detail: String(
          error?.message || error
        ),
      });
    }
  }
);

export default router;