# SmallClaw Webhook System

## Overview

SmallClaw includes a built-in webhook server that runs directly inside the gateway. Any service that can make an HTTP POST request can trigger it — no middleware, no n8n, no Zapier required.

The basic architecture is:

```
External Service → POST → SmallClaw Gateway (localhost:18789/hooks/agent)
```

Services that already support outgoing webhooks (GitHub, Stripe, Shopify, Vercel, etc.) connect directly. For apps that can't fire webhooks themselves (Google Sheets, RSS feeds, etc.), you can optionally add **n8n** as a local middleware layer — but it's never required.

---

## Quick Setup

### Step 1 — Build

```bat
cd D:\SmallClaw
.\build-webhooks.bat
```

### Step 2 — Enable in config

Edit `%USERPROFILE%\.smallclaw\config.json` and add:

```json
"hooks": {
  "enabled": true,
  "token": "pick-any-secret-string-here",
  "path": "/hooks"
}
```

### Step 3 — Restart the gateway

You'll see this line in the terminal when it's active:

```
[Webhooks] Listening at /hooks (wake, agent, status)
```

### Step 4 — Smoke test

```bat
.\test-webhooks.bat your-secret-string-here
```

---

## Endpoints

### `POST /hooks/agent` — Full agent run

The main endpoint. Accepts a message, runs the AI autonomously, and optionally delivers the response to Telegram.

**Returns 202 immediately** — the agent runs in the background.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | ✅ | The prompt/instruction for the AI |
| `name` | string | | Source label shown in logs and Telegram (e.g. `"GitHub"`) |
| `sessionKey` | string | | Persistent session ID — use the same key to maintain conversation context across calls |
| `deliver` | boolean | | Whether to send the response to Telegram (default: `true`) |
| `channel` | string | | Delivery channel — currently `"telegram"` or `"last"` (default: `"last"`) |
| `model` | string | | Override the model for this run |
| `timeoutSeconds` | number | | Max seconds before the run is aborted (default: 120, max: 300) |

**Example:**

```bash
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "New GitHub PR opened by alice titled: Fix login bug. Write a brief code review checklist.",
    "name": "GitHub",
    "deliver": true
  }'
```

**Response:**

```json
{
  "ok": true,
  "sessionId": "webhook_agent_1234567890",
  "source": "GitHub",
  "queued": true
}
```

---

### `POST /hooks/wake` — Lightweight nudge

A fast, low-overhead endpoint for simple event notifications. Injects a system event and optionally fires an immediate heartbeat-mode agent run.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✅ | The event description |
| `mode` | string | | `"now"` (triggers immediate agent run) or `"next-heartbeat"` (queues for next cycle). Default: `"now"` |

**Example:**

```bash
curl -X POST http://localhost:18789/hooks/wake \
  -H "x-smallclaw-token: your-token" \
  -H "Content-Type: application/json" \
  -d '{"text": "Build pipeline failed on main branch", "mode": "now"}'
```

---

### `GET /hooks/status` — Health check

Returns the current state of the webhook system. Useful for monitoring or testing connectivity.

```bash
curl -X GET http://localhost:18789/hooks/status \
  -H "x-smallclaw-token: your-token"
```

**Response:**

```json
{
  "ok": true,
  "enabled": true,
  "path": "/hooks",
  "modelBusy": false
}
```

---

## Authentication

All endpoints require a token. Two accepted header formats:

```
Authorization: Bearer your-token
```
```
x-smallclaw-token: your-token
```

Query-string tokens are **explicitly rejected** with a `400` error — this is intentional, since query params appear in server logs and browser history.

**Brute-force protection:** 5 failed auth attempts from the same IP triggers a 15-minute lockout. The response includes a `Retry-After` header.

---

## The localhost Problem (and Solutions)

SmallClaw runs on your local PC. Services like GitHub and Stripe can't reach `localhost:18789` from the internet. Pick one of the following:

### Tailscale (recommended for permanent setups)

Free, installs in 2 minutes, gives your PC a stable private IP accessible from anywhere you're signed into Tailscale.

```
http://100.x.x.x:18789/hooks/agent
```

No port forwarding, no router config, works on any network.

### ngrok (good for quick testing)

Creates a temporary public tunnel to your localhost:

```bash
ngrok http 18789
# → https://abc123.ngrok.io
```

Free tier URL changes on restart. Use the paid tier or Cloudflare Tunnel for a permanent URL.

### Cloudflare Tunnel (free, permanent)

Creates a real public HTTPS URL that tunnels to your localhost forever. More setup than ngrok but no URL changes and no cost.

### Local network only (no tunnel needed)

For triggers that run on your own machine or local network (scripts, Home Assistant, your phone on home WiFi), `localhost:18789` works fine without any tunnel.

---

## Integration Examples

### GitHub

In your repo: **Settings → Webhooks → Add webhook**

- Payload URL: `https://your-tunnel/hooks/agent`
- Content type: `application/json`
- Secret: *(leave blank — use `x-smallclaw-token` in a custom header if your CI supports it, otherwise use Tailscale + no public exposure)*

For a cleaner setup, use a GitHub Actions workflow that calls the webhook after events:

```yaml
- name: Notify SmallClaw
  run: |
    curl -X POST ${{ secrets.SMALLCLAW_WEBHOOK_URL }}/hooks/agent \
      -H "x-smallclaw-token: ${{ secrets.SMALLCLAW_TOKEN }}" \
      -H "Content-Type: application/json" \
      -d "{\"message\": \"PR #${{ github.event.number }} opened: ${{ github.event.pull_request.title }}\", \"name\": \"GitHub\"}"
```

### Stripe

**Dashboard → Developers → Webhooks → Add endpoint**

Point it at your tunnel URL. Then in the payload message, include the event type and relevant data.

### n8n (for apps without native webhooks)

n8n is an open-source workflow automation tool that runs locally and connects 1000+ apps. Use it when a service can't fire webhooks itself (e.g. "watch this Google Sheet for changes").

```
External App (Google Sheets, RSS, etc.)
         ↓
   n8n (localhost:5678)
         ↓
SmallClaw /hooks/agent
         ↓
   Response → Telegram
```

**Install n8n:**

```powershell
npm install -g n8n
n8n start
# Web UI at http://localhost:5678
```

**Example n8n HTTP node config** (to call SmallClaw):

- Method: `POST`
- URL: `http://localhost:18789/hooks/agent`
- Headers: `x-smallclaw-token: your-token`
- Body: `{"message": "{{your dynamic content}}", "name": "n8n", "deliver": true}`

### IFTTT

Use the **Webhooks** applet (formerly Maker). Point the `Make a web request` action at your tunnel URL with method `POST` and `application/json` body.

### Home Assistant

```yaml
rest_command:
  notify_smallclaw:
    url: "http://localhost:18789/hooks/agent"
    method: POST
    headers:
      x-smallclaw-token: "your-token"
      Content-Type: "application/json"
    payload: '{"message": "{{ message }}", "name": "HomeAssistant", "deliver": true}'
```

---

## Integration Reference Table

| Source | Needs Tunnel? | Needs n8n? | Notes |
|---|---|---|---|
| Script on your PC | ❌ | ❌ | `localhost` works directly |
| Phone on home WiFi | ❌ | ❌ | Same local network |
| Home Assistant (local) | ❌ | ❌ | Use `rest_command` |
| GitHub Actions | ✅ | ❌ | Native HTTP step |
| Stripe | ✅ | ❌ | Native webhooks |
| Shopify | ✅ | ❌ | Native webhooks |
| Vercel / Netlify | ✅ | ❌ | Deploy hooks |
| Grafana / uptime monitors | ✅ | ❌ | Alert channels |
| IFTTT | ✅ | ❌ | Webhooks applet |
| Google Sheets changes | ✅ | ✅ | No native webhook; n8n polls |
| RSS feed monitoring | ❌ | ✅ | n8n polls locally |
| Gmail | ✅ | ✅ | n8n Gmail trigger (OAuth) |
| Slack | ✅ | ✅ | n8n Slack trigger |

---

## Privacy & Data Sovereignty

Using the local stack means all data stays on your machine. No third-party servers in the middle.

**Cloud-based (Zapier/Make):**
```
Gmail → Third-party servers (US) → SmallClaw
```

**Local stack (SmallClaw webhooks + optional n8n):**
```
Gmail → n8n (your PC) → SmallClaw (your PC)
```

---

## Files Created

| File | Purpose |
|---|---|
| `src/gateway/webhook-handler.ts` | Core webhook logic — auth, rate limiting, endpoints, async agent runner |
| `src/gateway/server-v2.ts` | Modified to import and mount the webhook router |
| `src/config/config.ts` | Added `hooks` block to `DEFAULT_CONFIG` |
| `src/types.ts` | Added `hooks` TypeScript type to `SmallClawConfig` |
| `build-webhooks.bat` | One-click build script |
| `test-webhooks.bat` | Smoke test script — run after enabling to verify everything works |

---

## Config Reference

Full `hooks` config block with all options:

```json
"hooks": {
  "enabled": true,
  "token": "your-secret-token",
  "path": "/hooks"
}
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Master switch — set to `true` to activate |
| `token` | `""` | Required. Any string. Used for Bearer auth and `x-smallclaw-token` header |
| `path` | `"/hooks"` | URL prefix for all webhook endpoints |
