# Directory Structure
```
README.md
user.prompt.md
```

# Files

## File: README.md
````markdown
# WhatsApp API Gateway SaaS

A scalable, multi-provider WhatsApp API gateway that supports **tulir/whatsmeow**, **Baileys**, **whatsapp-web.js**, and **WhatsApp Business API (WABA)**. Each phone number runs in its own Docker container, managed by a central Cloudflare-powered control plane with seamless VPS migration and zero-downtime session persistence.

---

## 🚀 Features

- **Multi-Provider Support**: Choose between:
  - [tulir/whatsmeow](https://github.com/tulir/whatsmeow) (Go)
  - [Baileys](https://github.com/WhiskeySockets/Baileys) (TypeScript)
  - [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (Node.js)
  - [WhatsApp Business API (WABA)](https://developers.facebook.com/docs/whatsapp/business-management-api) (Official)

- **One Container = One Number**: Each WhatsApp number is isolated in its own Docker container.
- **Zero-Downtime Migration**: Move containers across VPS nodes without losing session state or requiring re-login.
- **Cloudflare Tunnel Integration**: Secure, scalable ingress without exposing VPS IPs.
- **State Persistence**: Sessions are backed up to a central database and restored on migration.
- **RESTful API**: Unified API across all providers.
- **Webhook Support**: Real-time message and status callbacks.
- **Multi-Tenant**: SaaS-ready with user isolation and billing hooks.

---

## 🧠 Architecture Overview

```
+---------------------+
|   Cloudflare Tunnel |
|  (Ingress + DNS)    |
+----------+----------+
           |
           v
+---------------------+
|  Gateway Controller |
|  (Node.js/Go)       |
|  - API Layer        |
|  - DB (PostgreSQL)  |
|  - Queue (Redis)    |
+----------+----------+
           |
           v
+---------------------+
|  Docker Swarm       |
|  or Kubernetes      |
|  - Per-number pods  |
|  - Volume snapshots |
+----------+----------+
           |
           v
+---------------------+
|  VPS Nodes          |
|  - Auto-scaling     |
|  - Health checks    |
+---------------------+
```

---

## 📦 Providers Comparison

| Provider         | Language | Multi-Device | Official | Notes |
|------------------|----------|--------------|----------|-------|
| whatsmeow        | Go       | ✅           | ❌       | Fast, reliable |
| Baileys          | JS       | ✅           | ❌       | Active community |
| whatsapp-web.js  | JS       | ✅           | ❌       | Easy to use |
| WABA             | HTTP     | ✅           | ✅       | Requires Meta approval |

---

## 🧪 Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/your-org/whatsapp-gateway-saas.git
cd whatsapp-gateway-saas
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

```env
# Core
DB_URL=postgres://user:pass@db:5432/whatsapp_gateway
REDIS_URL=redis://redis:6379
CF_TUNNEL_TOKEN=your-cloudflare-tunnel-token
API_SECRET=your-api-secret-key

# Providers (enable/disable)
ENABLE_WHATSMEOW=true
ENABLE_BAILEYS=true
ENABLE_WAWEBJS=true
ENABLE_WABA=true
```

### 3. Start the stack

```bash
docker compose up -d
```

### 4. Create a new instance

```bash
curl -X POST https://your-domain.com/api/instances \
  -H "Authorization: Bearer $API_SECRET" \
  -d '{
    "phone": "1234567890",
    "provider": "baileys",
    "webhook": "https://your-app.com/webhook"
  }'
```

### 5. Scan QR Code

```bash
curl https://your-domain.com/api/instances/1234567890/qr
```

---

## 🔁 Migration (Zero-Downtime)

To move a container from `vps-1` to `vps-2`:

```bash
curl -X POST https://your-domain.com/api/instances/1234567890/migrate \
  -H "Authorization: Bearer $API_SECRET" \
  -d '{
    "target_node": "vps-2"
  }'
```

**What happens:**
1. Container is paused
2. Session state is backed up to DB
3. Volume snapshot is created
4. New container starts on `vps-2`
5. Session is restored
6. Traffic is rerouted via Cloudflare
7. Old container is destroyed

---

## 📁 Project Structure

```
whatsapp-gateway-saas/
├── gateway/              # Central API controller
├── providers/
│   ├── whatsmeow/
│   ├── baileys/
│   ├── wawebjs/
│   └── waba/
├── migrations/           # DB schemas
├── scripts/
│   ├── backup.sh
│   ├── restore.sh
│   └── migrate.sh
├── docker-compose.yml
├── Dockerfile
└── README.md
```

---

## 🔐 Security

- API key-based authentication
- Cloudflare Access (optional)
- End-to-end encryption (provider-level)
- Webhook signature verification
- Rate limiting per instance
- No static IPs exposed

---

## 📊 Monitoring

- Prometheus metrics
- Grafana dashboards
- Loki logs
- Uptime Kuma for uptime tracking
- Webhook failure alerts

---

## 🧪 API Examples

### Send Text Message

```bash
curl -X POST https://your-domain.com/api/instances/1234567890/send \
  -H "Authorization: Bearer $API_SECRET" \
  -d '{
    "to": "919876543210",
    "type": "text",
    "text": "Hello from SaaS!"
  }'
```

### Send Media

```bash
curl -X POST https://your-domain.com/api/instances/1234567890/send \
  -H "Authorization: Bearer $API_SECRET" \
  -F 'to=919876543210' \
  -F 'type=image' \
  -F 'file=@/path/to/image.jpg'
```

---

## 🧩 Webhook Payload

```json
{
  "instance": "1234567890",
  "timestamp": "2025-11-17T12:00:00Z",
  "type": "message",
  "data": {
    "from": "919876543210",
    "type": "text",
    "text": "Hi there"
  }
}
```

---

## 🧑‍💻 Development

### Add a new provider

1. Create folder under `providers/`
2. Implement interface:

```ts
interface Provider {
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(msg: Message): Promise<void>
  getQR(): Promise<string>
  restoreSession(state: string): Promise<void>
  backupSession(): Promise<string>
}
```

3. Register in `gateway/providers/index.ts`

---

## 📈 Scaling

- Use Docker Swarm or Kubernetes
- Enable volume snapshots (e.g., Restic, Velero)
- Use Redis for session caching
- Use PostgreSQL with replicas
- Use Cloudflare Load Balancer for global failover

---

## 📜 License

MIT License — see [LICENSE](LICENSE)

---

## 🤝 Contributing

PRs welcome. Please open an issue first for large changes.

---

## ⚠️ Disclaimer

This project is for **legitimate business use only**. Misuse (spam, abuse, etc.) may result in bans from WhatsApp. You are responsible for complying with [WhatsApp Terms of Service](https://www.whatsapp.com/legal/).

---

## 📞 Support

- Discord: [https://discord.gg/your-server](https://discord.gg/your-server)
- Email: support@your-domain.com
```

Let me know if you want a Kubernetes Helm chart or Terraform module next.
````

## File: user.prompt.md
````markdown
====

understand readme.md then plan!
````
