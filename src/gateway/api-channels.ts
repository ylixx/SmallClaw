/** api-channels.ts — Telegram/Discord/WhatsApp channel config + test routes
 * extracted from server-v2.ts (Phase 5d-8). Channel normalize helpers are
 * exported (used by telegram-channel init at the composition root). */
import express from 'express';
import { getConfig } from '../config/config';

export interface ChannelsRouteDeps {
  telegramChannel: {
    getStatus: () => any;
    updateConfig: (cfg: any) => void;
    sendToAllowed: (text: string) => Promise<void>;
  };
}



type TelegramChannelConfig = {
  enabled: boolean;
  botToken: string;
  allowedUserIds: number[];
  streamMode: 'full' | 'partial';
};



type DiscordChannelConfig = {
  enabled: boolean;
  botToken: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  webhookUrl: string;
};



type WhatsAppChannelConfig = {
  enabled: boolean;
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  verifyToken: string;
  webhookSecret: string;
  testRecipient: string;
};



type ChannelsConfig = {
  telegram: TelegramChannelConfig;
  discord: DiscordChannelConfig;
  whatsapp: WhatsAppChannelConfig;
};



// HIGH-01 fix: resolve vault references when normalizing channel configs.
// Tokens stored as "vault:<key>" are decrypted here at point-of-use,
// so they never have to be plaintext in config.json.
function resolveToken(raw: string | undefined): string {
  if (!raw) return '';
  return getConfig().resolveSecret(raw) || '';
}



function normalizeTelegramConfig(raw: any): TelegramChannelConfig {
  return {
    enabled: raw?.enabled === true,
    botToken: resolveToken(raw?.botToken),
    allowedUserIds: Array.isArray(raw?.allowedUserIds) ? raw.allowedUserIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0) : [],
    streamMode: raw?.streamMode === 'partial' ? 'partial' : 'full',
  };
}



function normalizeDiscordConfig(raw: any): DiscordChannelConfig {
  return {
    enabled: raw?.enabled === true,
    botToken: resolveToken(raw?.botToken),
    applicationId: String(raw?.applicationId || ''),
    guildId: String(raw?.guildId || ''),
    channelId: String(raw?.channelId || ''),
    webhookUrl: resolveToken(raw?.webhookUrl) || String(raw?.webhookUrl || ''),
  };
}



function normalizeWhatsAppConfig(raw: any): WhatsAppChannelConfig {
  return {
    enabled: raw?.enabled === true,
    accessToken: resolveToken(raw?.accessToken),
    phoneNumberId: String(raw?.phoneNumberId || ''),
    businessAccountId: String(raw?.businessAccountId || ''),
    verifyToken: resolveToken(raw?.verifyToken) || String(raw?.verifyToken || ''),
    webhookSecret: resolveToken(raw?.webhookSecret) || String(raw?.webhookSecret || ''),
    testRecipient: String(raw?.testRecipient || ''),
  };
}



export function resolveChannelsConfig(): ChannelsConfig {
  const cfg = getConfig().getConfig() as any;
  const channels = cfg.channels || {};
  const legacyTelegram = cfg.telegram || {};
  return {
    telegram: normalizeTelegramConfig({ ...(channels.telegram || {}), ...legacyTelegram }),
    discord: normalizeDiscordConfig(channels.discord || {}),
    whatsapp: normalizeWhatsAppConfig(channels.whatsapp || {}),
  };
}



export function registerChannelsRoutes(app: express.Express, deps: ChannelsRouteDeps): void {
// ─── Channels API ──────────────────────────────────────────────────────────────

async function testTelegramConfig(token: string): Promise<{ success: boolean; bot?: any; error?: string }> {
  if (!token) return { success: false, error: 'No Telegram bot token provided' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: 'POST' });
    const data: any = await resp.json();
    if (!data.ok) return { success: false, error: data.description || 'Invalid token' };
    return { success: true, bot: { username: data.result.username, firstName: data.result.first_name, id: data.result.id } };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

async function testDiscordConfig(dc: DiscordChannelConfig): Promise<{ success: boolean; bot?: any; error?: string }> {
  if (!dc.botToken) return { success: false, error: 'No Discord bot token provided' };
  try {
    const meResp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${dc.botToken}` },
    });
    const meData: any = await meResp.json();
    if (!meResp.ok) return { success: false, error: meData?.message || `Discord API ${meResp.status}` };

    return {
      success: true,
      bot: { username: meData.username, id: meData.id, discriminator: meData.discriminator },
    };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

async function testWhatsAppConfig(wa: WhatsAppChannelConfig): Promise<{ success: boolean; account?: any; error?: string }> {
  if (!wa.accessToken) return { success: false, error: 'No WhatsApp access token provided' };
  if (!wa.phoneNumberId) return { success: false, error: 'No WhatsApp phone number ID provided' };
  try {
    const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(wa.phoneNumberId)}?fields=id,display_phone_number,verified_name`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${wa.accessToken}` },
    });
    const data: any = await resp.json();
    if (!resp.ok) return { success: false, error: data?.error?.message || `WhatsApp API ${resp.status}` };
    return { success: true, account: data };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

app.get('/api/channels/status', (_req, res) => {
  const runtimeTelegram = deps.telegramChannel.getStatus();
  const channels = resolveChannelsConfig();

  res.json({
    success: true,
    telegram: {
      ...runtimeTelegram,
      enabled: channels.telegram.enabled,
      hasToken: !!channels.telegram.botToken,
      allowedUserIds: channels.telegram.allowedUserIds,
    },
    discord: {
      enabled: channels.discord.enabled,
      hasToken: !!channels.discord.botToken,
      hasWebhook: !!channels.discord.webhookUrl,
      applicationId: channels.discord.applicationId,
      guildId: channels.discord.guildId,
      channelId: channels.discord.channelId,
    },
    whatsapp: {
      enabled: channels.whatsapp.enabled,
      hasAccessToken: !!channels.whatsapp.accessToken,
      phoneNumberId: channels.whatsapp.phoneNumberId,
      businessAccountId: channels.whatsapp.businessAccountId,
      verifyTokenSet: !!channels.whatsapp.verifyToken,
      webhookSecretSet: !!channels.whatsapp.webhookSecret,
      testRecipient: channels.whatsapp.testRecipient,
    },
  });
});

app.post('/api/channels/config', async (req, res) => {
  const incoming = req.body?.channels || {};
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const existing = resolveChannelsConfig();

  const mergedTelegram = normalizeTelegramConfig({ ...existing.telegram, ...(incoming.telegram || {}) });
  const mergedDiscord = normalizeDiscordConfig({ ...existing.discord, ...(incoming.discord || {}) });
  const mergedWhatsApp = normalizeWhatsAppConfig({ ...existing.whatsapp, ...(incoming.whatsapp || {}) });

  const channels = {
    ...(current.channels || {}),
    telegram: mergedTelegram,
    discord: mergedDiscord,
    whatsapp: mergedWhatsApp,
  };

  // Keep legacy top-level telegram key in sync for backward compatibility.
  cm.updateConfig({
    channels,
    telegram: mergedTelegram,
  } as any);

  deps.telegramChannel.updateConfig(mergedTelegram);

  res.json({
    success: true,
    channels: {
      telegram: { enabled: mergedTelegram.enabled, hasToken: !!mergedTelegram.botToken, allowedUserIds: mergedTelegram.allowedUserIds },
      discord: { enabled: mergedDiscord.enabled, hasToken: !!mergedDiscord.botToken, hasWebhook: !!mergedDiscord.webhookUrl },
      whatsapp: { enabled: mergedWhatsApp.enabled, hasAccessToken: !!mergedWhatsApp.accessToken, phoneNumberId: mergedWhatsApp.phoneNumberId },
    },
  });
});

app.post('/api/channels/test/:channel', async (req, res) => {
  const channel = String(req.params.channel || '').toLowerCase();
  const channels = resolveChannelsConfig();

  if (channel === 'telegram') {
    const token = String(req.body?.botToken || channels.telegram.botToken || '');
    const result = await testTelegramConfig(token);
    res.json(result);
    return;
  }

  if (channel === 'discord') {
    const dc = normalizeDiscordConfig({ ...channels.discord, ...(req.body || {}) });
    const result = await testDiscordConfig(dc);
    res.json(result);
    return;
  }

  if (channel === 'whatsapp') {
    const wa = normalizeWhatsAppConfig({ ...channels.whatsapp, ...(req.body || {}) });
    const result = await testWhatsAppConfig(wa);
    res.json(result);
    return;
  }

  res.status(400).json({ success: false, error: `Unsupported channel: ${channel}` });
});

app.post('/api/channels/send-test/:channel', async (req, res) => {
  const channel = String(req.params.channel || '').toLowerCase();
  const channels = resolveChannelsConfig();

  if (channel === 'telegram') {
    try {
      await deps.telegramChannel.sendToAllowed('🦞 SmallClaw test message - Telegram is connected!');
      res.json({ success: true });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  if (channel === 'discord') {
    const dc = normalizeDiscordConfig({ ...channels.discord, ...(req.body || {}) });
    const text = String(req.body?.text || '🦞 SmallClaw test message - Discord is connected!');
    if (dc.webhookUrl) {
      try {
        const resp = await fetch(dc.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          res.json({ success: false, error: body || `Discord webhook HTTP ${resp.status}` });
          return;
        }
        res.json({ success: true });
      } catch (err: any) {
        res.json({ success: false, error: String(err?.message || err) });
      }
      return;
    }
    if (!dc.botToken || !dc.channelId) {
      res.json({ success: false, error: 'Provide Discord webhook URL or bot token + channel ID' });
      return;
    }
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(dc.channelId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${dc.botToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: text }),
      });
      const data: any = await resp.json();
      if (!resp.ok) {
        res.json({ success: false, error: data?.message || `Discord API ${resp.status}` });
        return;
      }
      res.json({ success: true, messageId: data?.id });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  if (channel === 'whatsapp') {
    const wa = normalizeWhatsAppConfig({ ...channels.whatsapp, ...(req.body || {}) });
    const to = String(req.body?.to || wa.testRecipient || '').trim();
    const text = String(req.body?.text || 'SmallClaw test message - WhatsApp is connected!');
    if (!wa.accessToken || !wa.phoneNumberId || !to) {
      res.json({ success: false, error: 'Provide WhatsApp access token, phone number ID, and test recipient number' });
      return;
    }
    try {
      const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${wa.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
      const data: any = await resp.json();
      if (!resp.ok) {
        res.json({ success: false, error: data?.error?.message || `WhatsApp API ${resp.status}` });
        return;
      }
      res.json({ success: true, messageId: data?.messages?.[0]?.id || null });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  res.status(400).json({ success: false, error: `Unsupported channel: ${channel}` });
});

// Legacy Telegram endpoints (compatibility wrappers)
app.get('/api/telegram/status', (_req, res) => {
  const runtimeTelegram = deps.telegramChannel.getStatus();
  const channels = resolveChannelsConfig();
  res.json({
    success: true,
    ...runtimeTelegram,
    enabled: channels.telegram.enabled,
    hasToken: !!channels.telegram.botToken,
    allowedUserIds: channels.telegram.allowedUserIds,
  });
});

app.post('/api/telegram/config', async (req, res) => {
  const incoming = req.body || {};
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const existing = resolveChannelsConfig();
  const mergedTelegram = normalizeTelegramConfig({ ...existing.telegram, ...incoming });
  const channels = {
    ...(current.channels || {}),
    telegram: mergedTelegram,
    discord: existing.discord,
    whatsapp: existing.whatsapp,
  };
  cm.updateConfig({ channels, telegram: mergedTelegram } as any);
  deps.telegramChannel.updateConfig(mergedTelegram);
  res.json({ success: true, config: { enabled: mergedTelegram.enabled, hasToken: !!mergedTelegram.botToken, allowedUserIds: mergedTelegram.allowedUserIds } });
});

app.post('/api/telegram/test', async (req, res) => {
  const channels = resolveChannelsConfig();
  const token = String(req.body?.botToken || channels.telegram.botToken || '');
  const result = await testTelegramConfig(token);
  res.json(result);
});

app.post('/api/telegram/send-test', async (req, res) => {
  try {
    await deps.telegramChannel.sendToAllowed('🦞 SmallClaw test message - Telegram is connected!');
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err) });
  }
});
}
