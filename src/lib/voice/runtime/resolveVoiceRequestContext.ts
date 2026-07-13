//src/lib/voice/runtime/resolveVoiceRequestContext.ts
import { twiml } from "twilio";

import pool from "../../db";
import { canUseChannel } from "../../features";
import { deleteVoiceCallState } from "../deleteVoiceCallState";
import { resolveEffectiveVoiceLocale } from "../resolveVoiceLanguage";
import { renderVoiceReply } from "../renderVoiceReply";
import { renderVoiceLifecycle } from "../renderVoiceLifecycle";
import { resolveVoiceProviderVoice } from "../resolveVoiceProviderVoice";
import { getTenantBrand } from "./voiceSmsRuntime";

import type { CallState, VoiceLocale } from "../types";

type TenantRow = {
  id: string;
  name?: string | null;
  info_clave?: string | null;
  membresia_activa?: boolean | null;
  membresia_inicio?: string | Date | null;
  twilio_sms_number?: string | null;
  twilio_voice_number?: string | null;
};

type VoiceConfigRow = {
  idioma?: string | null;
  voice_name?: string | null;
  representante_number?: string | null;
  system_prompt?: string | null;
  [key: string]: any;
};

type ResolveVoiceRequestContextParams = {
  callSid: string;
  didNumber: string;
  state: CallState;
  langParam?: string;
  channelKey: string;
};

type ResolveVoiceRequestContextBlockedResult = {
  ok: false;
  twiml: string;
};

type ResolveVoiceRequestContextSuccessResult = {
  ok: true;
  tenant: TenantRow;
  cfg: VoiceConfigRow;
  brand: string;
  currentLocale: VoiceLocale;
  voiceName: string;
};

export type ResolveVoiceRequestContextResult =
  | ResolveVoiceRequestContextBlockedResult
  | ResolveVoiceRequestContextSuccessResult;

export async function resolveVoiceRequestContext({
  callSid,
  didNumber,
  state,
  langParam,
  channelKey,
}: ResolveVoiceRequestContextParams): Promise<ResolveVoiceRequestContextResult> {
  const tenantRes = await pool.query(
    `SELECT id, name, info_clave,
            membresia_activa, membresia_inicio,
            twilio_sms_number, twilio_voice_number
     FROM tenants
    WHERE twilio_voice_number = $1
    LIMIT 1`,
    [didNumber]
  );

  const tenant = tenantRes.rows[0] as TenantRow | undefined;

  if (!tenant) {
    throw new Error(`tenant_not_found:${didNumber}`);
  }

  try {
    const gate = await canUseChannel(tenant.id, "voice");

    if (!gate.enabled) {
      await deleteVoiceCallState(callSid);

      const vr = new twiml.VoiceResponse();
      const lang =
        ((state.lang as any) ||
          (langParam === "es"
            ? "es-ES"
            : langParam === "pt"
            ? "pt-BR"
            : "en-US")) as VoiceLocale;

      const msg = renderVoiceReply("voice_channel_unavailable", {
        locale: lang,
      });

      console.log("🛑 VOZ bloqueado por plan/toggle/pausa", {
        tenantId: tenant.id,
        plan_enabled: gate.plan_enabled,
        settings_enabled: gate.settings_enabled,
        paused_until: gate.paused_until,
        reason: gate.reason,
      });

      vr.say(
        { language: lang as any, voice: resolveVoiceProviderVoice(lang) as any },
        msg
      );
      vr.hangup();

      return {
        ok: false,
        twiml: vr.toString(),
      };
    }
  } catch (error) {
    console.warn(
      "Guard VOZ: error en canUseChannel('voice'); bloquea por seguridad:",
      error
    );

    await deleteVoiceCallState(callSid);

    const vr = new twiml.VoiceResponse();
    vr.say(
      {
        language: "es-ES" as any,
        voice: resolveVoiceProviderVoice("es-ES") as any,
      },
      renderVoiceLifecycle("generic_voice_unavailable", "es-ES")
    );
    vr.hangup();

    return {
      ok: false,
      twiml: vr.toString(),
    };
  }

  if (!tenant.membresia_activa) {
    const vr = new twiml.VoiceResponse();

    const lang =
      ((state.lang as any) ||
        (langParam === "es"
          ? "es-ES"
          : langParam === "pt"
          ? "pt-BR"
          : "en-US")) as VoiceLocale;

    const text = renderVoiceReply("assistant_unavailable", {
      locale: lang,
    });

    vr.say(
      {
        voice: resolveVoiceProviderVoice(lang) as any,
        language: lang as any,
      },
      text
    );
    vr.hangup();

    return {
      ok: false,
      twiml: vr.toString(),
    };
  }

  const currentLocale = resolveEffectiveVoiceLocale({
    persistedLang: state.lang,
    queryLang: langParam,
    fallback: "en-US",
  });

  let cfgRes = await pool.query(
    `SELECT *
       FROM voice_configs
      WHERE tenant_id = $1
        AND canal = $2
        AND idioma = $3
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    [tenant.id, channelKey, currentLocale]
  );

  let cfg = cfgRes.rows[0] as VoiceConfigRow | undefined;

  if (!cfg) {
    cfgRes = await pool.query(
      `SELECT *
         FROM voice_configs
        WHERE tenant_id = $1
          AND canal = $2
        ORDER BY
          CASE
            WHEN idioma = 'en-US' THEN 0
            WHEN idioma = 'es-ES' THEN 1
            WHEN idioma = 'pt-BR' THEN 2
            ELSE 3
          END,
          updated_at DESC,
          created_at DESC
        LIMIT 1`,
      [tenant.id, channelKey]
    );

    cfg = cfgRes.rows[0] as VoiceConfigRow | undefined;
  }

  if (!cfg) {
    throw new Error(
      `voice_config_not_found:${tenant.id}:${currentLocale}:${channelKey}`
    );
  }

  if (!String(cfg.representante_number || "").trim()) {
    const representativeRes = await pool.query(
      `SELECT representante_number
        FROM voice_configs
        WHERE tenant_id = $1
          AND canal = $2
          AND representante_number IS NOT NULL
          AND TRIM(representante_number) <> ''
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      [tenant.id, channelKey]
    );

    const representativeNumber = String(
      representativeRes.rows[0]?.representante_number || ""
    ).trim();

    if (representativeNumber) {
      cfg = {
        ...cfg,
        representante_number: representativeNumber,
      };
    }
  }

  const cfgLocale = String(cfg.idioma || "").trim();

  const localeCompatibleVoiceName =
    cfgLocale === currentLocale ? cfg.voice_name : undefined;

  const voiceName = resolveVoiceProviderVoice(
    currentLocale,
    localeCompatibleVoiceName
  ) as string;

  const brand = await getTenantBrand(tenant.id);

  return {
    ok: true,
    tenant,
    cfg,
    brand,
    currentLocale,
    voiceName,
  };
}