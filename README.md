# WhatsApp API Gateway SaaS

A scalable, multi-provider WhatsApp API gateway that supports **tulir/whatsmeow**, **Baileys**, **whatsapp-web.js**, and **WhatsApp Business API (WABA)**. Each phone number runs in its own Docker container, managed by a central **Bun-powered** control plane with seamless VPS migration and zero-downtime session persistence.

---

## 🚀 Features

- **Multi-Provider Support**:
  - [tulir/whatsmeow](https://github.com/tulir/whatsmeow) (Go)
  - [Baileys](https://github.com/WhiskeySockets/Baileys) (TypeScript)
  - [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (Node.js)
  - [WhatsApp Business API (WABA)](https://developers.facebook.com/docs/whatsapp/business-management-api) (Official)

- **One Container = One Number**: Each WhatsApp number is isolated in its own Docker container.
- **Resource Limiting**: Set CPU and RAM limits per container to prevent noisy neighbors and ensure fair usage.
- **Zero-Downtime Migration**: Move containers across VPS nodes without losing session state.
- **Cloudflare Tunnel Integration**: Secure, scalable ingress without exposing VPS IPs.
- **State Persistence**: Sessions backed up to a central database (PostgreSQL + Drizzle ORM).
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
|  (Bun.sh / Go)      |
|  - API Layer        |
|  - DB (PostgreSQL)  |
|  - Drizzle ORM      |
|  - Queue (Redis)    |
+----------+----------+
           |
           v
+---------------------+
|  Docker Swarm       |
|  or Kubernetes      |
|  - Per-number pods  |
|  - Resource limits  |
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
# Edit .env with your credentials
bun install
```

### 3. Start the stack

```bash
docker compose up -d
```

### 4. Run migrations

```bash
bun run db:migrate
```

### 5. Create a new instance

```bash
curl -X POST https://your-domain.com/api/instances \
  -H "Authorization: Bearer $API_SECRET" \
  -d '{
    "phone": "1234567890",
    "provider": "baileys",
    "webhook": "https://your-app.com/webhook",
    "resources": {
      "cpu": "0.5",
      "memory": "512m"
    }
  }'
```

### 6. Scan QR Code

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
├── gateway/              # Central API controller (Bun.sh)
├── providers/
│   ├── whatsmeow/
│   ├── baileys/
│   ├── wawebjs/
│   └── waba/
├── drizzle/              # Drizzle ORM schemas + migrations
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

## 📈 Scaling

- Use Docker Swarm or Kubernetes for orchestration.
- Set resource limits on containers to manage costs and prevent abuse.
- Use a managed PostgreSQL (e.g., Neon, Supabase) and Redis.
- Use Cloudflare Load Balancer for global failover.

---

## 📜 License

MIT

---

## ⚠️ Disclaimer

This is not an official WhatsApp product. Use it for legitimate purposes only. Spamming will get your numbers banned. You are responsible for complying with WhatsApp's ToS.

---

## 📞 Support

- Discord: [https://discord.gg/your-server](https://discord.gg/your-server)
- Issues via GitHub.
