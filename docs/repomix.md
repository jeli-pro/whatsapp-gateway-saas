# Directory Structure
```
drizzle/
  schema.ts
gateway/
  src/
    docker.service.ts
    index.ts
  package.json
  tsconfig.json
providers/
  whatsmeow/
    Dockerfile
    go.mod
    main.go
.env.example
drizzle.config.ts
package.json
README.md
user.prompt.md
```

# Files

## File: drizzle/schema.ts
````typescript
import { pgTable, serial, text, varchar, timestamp, integer, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 256 }).notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const providerEnum = pgEnum('provider', ['whatsmeow', 'baileys', 'wawebjs', 'waba']);
export const instanceStatusEnum = pgEnum('status', ['creating', 'starting', 'running', 'stopped', 'error']);

export const instances = pgTable('instances', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    phoneNumber: varchar('phone_number', { length: 20 }).notNull(),
    provider: providerEnum('provider').notNull(),
    webhookUrl: text('webhook_url'),
    status: instanceStatusEnum('status').default('creating').notNull(),
    cpuLimit: varchar('cpu_limit', { length: 10 }).default('0.5'), // e.g., "0.5"
    memoryLimit: varchar('memory_limit', { length: 10 }).default('512m'), // e.g., "512m"
    createdAt: timestamp('created_at').defaultNow().notNull(),
  }, (table) => {
    return {
      userPhoneIdx: uniqueIndex('user_phone_idx').on(table.userId, table.phoneNumber),
    };
});

export const userRelations = relations(users, ({ many }) => ({
  instances: many(instances),
}));

export const instanceRelations = relations(instances, ({ one }) => ({
  user: one(users, {
    fields: [instances.userId],
    references: [users.id],
  }),
}));
````

## File: gateway/src/docker.service.ts
````typescript
import Docker from 'dockerode';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const DOCKER_IMAGE = 'whatsapp-gateway-saas-whatsmeow'; // Assume this is built and tagged

interface CreateContainerOptions {
    instanceId: number;
    webhookUrl: string;
    cpuLimit: string;
    memoryLimit: string;
}

export async function createAndStartContainer(options: CreateContainerOptions) {
    const containerName = `instance-${options.instanceId}`;
    console.log(`Creating container ${containerName}`);

    // First, try to pull the image to ensure it's up to date
    await pullImage(DOCKER_IMAGE);

    const container = await docker.createContainer({
        Image: DOCKER_IMAGE,
        name: containerName,
        Env: [
            `WEBHOOK_URL=${options.webhookUrl}`
        ],
        HostConfig: {
            // Restart unless manually stopped
            RestartPolicy: {
                Name: 'unless-stopped',
            },
            // Resource limits
            NanoCpus: Math.floor(parseFloat(options.cpuLimit) * 1e9), // e.g. 0.5 -> 500000000
            Memory: parseMemory(options.memoryLimit), // e.g. "512m" -> 536870912
        },
        Labels: {
            'whatsapp-gateway-saas.instance-id': String(options.instanceId),
        }
    });

    console.log(`Starting container ${container.id}`);
    await container.start();

    return container;
}

export async function stopAndRemoveContainer(instanceId: number) {
    const containerName = `instance-${instanceId}`;
    try {
        const container = docker.getContainer(containerName);
        const inspect = await container.inspect();
        if (inspect.State.Running) {
            console.log(`Stopping container ${containerName}`);
            await container.stop();
        }
        console.log(`Removing container ${containerName}`);
        await container.remove();
        return true;
    } catch (error: any) {
        if (error.statusCode === 404) {
            console.log(`Container ${containerName} not found, nothing to do.`);
            return true;
        }
        console.error(`Error stopping/removing container ${containerName}:`, error);
        throw error;
    }
}

export async function findContainer(instanceId: number) {
    try {
        const container = docker.getContainer(`instance-${instanceId}`);
        return await container.inspect();
    } catch (error: any) {
        if (error.statusCode === 404) {
            return null;
        }
        throw error;
    }
}

function pullImage(imageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        console.log(`Pulling image ${imageName}...`);
        docker.pull(imageName, (err: Error, stream: NodeJS.ReadableStream) => {
            if (err) {
                return reject(err);
            }
            docker.modem.followProgress(stream, onFinished, onProgress);

            function onFinished(err: Error | null, output: any) {
                if (err) {
                    return reject(err);
                }
                console.log(`Image ${imageName} pulled successfully.`);
                resolve();
            }
            function onProgress(event: any) {
                // You can add progress reporting here if needed
            }
        });
    });
}

function parseMemory(mem: string): number {
    const unit = mem.charAt(mem.length - 1).toLowerCase();
    const value = parseInt(mem.slice(0, -1), 10);
    switch (unit) {
        case 'g': return value * 1024 * 1024 * 1024;
        case 'm': return value * 1024 * 1024;
        case 'k': return value * 1024;
        default: return parseInt(mem, 10);
    }
}
````

## File: gateway/src/index.ts
````typescript
import { Elysia, t } from 'elysia';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../../drizzle/schema';
import { createAndStartContainer, findContainer, stopAndRemoveContainer } from './docker.service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });

const API_SECRET = process.env.API_SECRET;
if (!API_SECRET) {
  throw new Error("API_SECRET is not set");
}

// A simple proxy to fetch data from a container
async function proxyToContainer(containerIp: string, path: string, options?: RequestInit) {
    const url = `http://${containerIp}:8080${path}`;
    try {
        const response = await fetch(url, options);
        return response;
    } catch (e) {
        console.error(`Failed to proxy request to ${url}`, e);
        return null;
    }
}


const app = new Elysia()
  .get('/', () => ({ status: 'ok' }))
  .group('/api', (app) => app
    // Simple bearer token auth
    .onBeforeHandle(({ headers, set }) => {
        const auth = headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ') || auth.substring(7) !== API_SECRET) {
            set.status = 401;
            return { error: 'Unauthorized' };
        }
    })
    .post('/instances', async ({ body, set }) => {
        // TODO: Tie to an authenticated user
        // For now, assuming user with ID 1 exists and is the only user.
        const [newInstance] = await db.insert(schema.instances).values({
            userId: 1, 
            phoneNumber: body.phone,
            provider: body.provider,
            webhookUrl: body.webhook,
            cpuLimit: body.resources?.cpu,
            memoryLimit: body.resources?.memory,
            status: 'creating',
        }).returning();

        if (!newInstance) {
            set.status = 500;
            return { error: 'Failed to create instance in database' };
        }

        try {
            await createAndStartContainer({
                instanceId: newInstance.id,
                webhookUrl: newInstance.webhookUrl || '',
                cpuLimit: newInstance.cpuLimit || '0.5',
                memoryLimit: newInstance.memoryLimit || '512m',
            });
            const [updatedInstance] = await db.update(schema.instances)
                .set({ status: 'running' })
                .where(eq(schema.instances.id, newInstance.id))
                .returning();
            return updatedInstance;
        } catch (error) {
            console.error('Failed to start container:', error);
            await db.update(schema.instances)
                .set({ status: 'error' })
                .where(eq(schema.instances.id, newInstance.id));
            set.status = 500;
            return { error: 'Failed to start container for instance' };
        }
    }, {
        body: t.Object({
            phone: t.String(),
            provider: t.Enum(schema.providerEnum),
            webhook: t.Optional(t.String()),
            resources: t.Optional(t.Object({
                cpu: t.String(),
                memory: t.String(),
            }))
        })
    })
    .get('/instances/:id/qr', async ({ params, set }) => {
        const instanceId = parseInt(params.id, 10);
        const containerInfo = await findContainer(instanceId);

        if (!containerInfo || !containerInfo.State.Running) {
            set.status = 404;
            return { error: 'Instance container not found or not running' };
        }
        
        const ip = containerInfo.NetworkSettings.IPAddress;
        if (!ip) {
             set.status = 500;
             return { error: "Could not determine container IP address." };
        }

        const qrResponse = await proxyToContainer(ip, '/qr');
        if (!qrResponse) {
            set.status = 503;
            return { error: "Failed to connect to instance container." };
        }
        if (!qrResponse.ok) {
            set.status = qrResponse.status;
            return { error: `Instance returned an error: ${qrResponse.statusText}`};
        }
        
        return { qr: await qrResponse.text() };
    })
    .post('/instances/:id/send', async ({ params, body, set }) => {
        const instanceId = parseInt(params.id, 10);
        const containerInfo = await findContainer(instanceId);

        if (!containerInfo || !containerInfo.State.Running) {
            set.status = 404;
            return { error: 'Instance container not found or not running' };
        }
        const ip = containerInfo.NetworkSettings.IPAddress;
        if (!ip) {
             set.status = 500;
             return { error: "Could not determine container IP address." };
        }

        const sendResponse = await proxyToContainer(ip, '/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!sendResponse) {
            set.status = 503;
            return { error: "Failed to connect to instance container." };
        }
        set.status = sendResponse.status;
        return await sendResponse.json();
    }, {
        body: t.Object({
            to: t.String(),
            text: t.String(),
        })
    })
    .delete('/instances/:id', async ({ params, set }) => {
        const instanceId = parseInt(params.id, 10);

        try {
            await stopAndRemoveContainer(instanceId);
            await db.delete(schema.instances).where(eq(schema.instances.id, instanceId));
            set.status = 204;
        } catch (error) {
            console.error('Failed to delete instance:', error);
            set.status = 500;
            return { error: 'Failed to delete instance' };
        }
    })
  )
  .listen(3000);

console.log(
  `🦊 Gateway is running at ${app.server?.hostname}:${app.server?.port}`
);
````

## File: gateway/package.json
````json
{
  "name": "gateway",
  "module": "src/index.ts",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts"
  },
  "devDependencies": {
    "bun-types": "latest",
    "@types/dockerode": "latest"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "elysia": "latest",
    "drizzle-orm": "latest",
    "postgres": "latest",
    "dockerode": "latest"
  }
}
````

## File: gateway/tsconfig.json
````json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "composite": true,
    "strict": true,
    "downlevelIteration": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "allowJs": true,
    "types": [
      "bun-types"
    ]
  }
}
````

## File: providers/whatsmeow/Dockerfile
````
# --- Build Stage ---
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum files
COPY go.mod ./
# If you have a go.sum, copy it too
# COPY go.sum ./

# Download dependencies
# This is a separate step to leverage Docker cache
RUN go mod download

# Copy the source code
COPY . .

# Build the Go app
# -ldflags="-w -s" strips debug information and symbols to reduce binary size
# CGO_ENABLED=0 is important for a static binary for scratch image
RUN CGO_ENABLED=0 go build -ldflags="-w -s" -o /whatsapp-provider .

# --- Final Stage ---
FROM alpine:latest

# Create a directory for session data
RUN mkdir /session && chown 1000:1000 /session

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Copy binary from builder
COPY --from=builder /whatsapp-provider /whatsapp-provider

# Expose the internal API port
EXPOSE 8080

# Define a volume for session data
VOLUME /session

# Command to run the application
CMD ["/whatsapp-provider"]
````

## File: providers/whatsmeow/go.mod
````
module github.com/your-org/whatsapp-gateway-saas/providers/whatsmeow

go 1.21

require (
	github.com/mattn/go-sqlite3 v1.14.17
	github.com/skip2/go-qrcode v0.0.0-20200617195104-da1b6568686e
	go.mau.fi/whatsmeow v0.0.0-20240123133441-a2223838128a
	google.golang.org/protobuf v1.31.0
)
````

## File: providers/whatsmeow/main.go
````go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var client *whatsmeow.Client
var log waLog.Logger
var qrCodeStr string
var qrCodeMutex sync.RWMutex

type webhookPayload struct {
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

func eventHandler(evt interface{}) {
	webhookURL := os.Getenv("WEBHOOK_URL")
	if webhookURL == "" {
		return // No webhook configured
	}

	var payload webhookPayload
	switch v := evt.(type) {
	case *events.Message:
		log.Infof("Received message from %s: %s", v.Info.Sender, v.Message.GetConversation())
		payload = webhookPayload{Event: "message", Data: v}
	case *events.Connected:
		log.Infof("Connected to WhatsApp")
		payload = webhookPayload{Event: "connected", Data: nil}
	case *events.Disconnected:
		log.Infof("Disconnected from WhatsApp")
		payload = webhookPayload{Event: "disconnected", Data: nil}
	default:
		return // Ignore other events for now
	}

	go sendWebhook(webhookURL, payload)
}

func sendWebhook(url string, payload webhookPayload) {
	data, err := json.Marshal(payload)
	if err != nil {
		log.Errorf("Failed to marshal webhook payload: %v", err)
		return
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(data))
	if err != nil {
		log.Errorf("Failed to create webhook request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Errorf("Failed to send webhook: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		log.Warnf("Webhook call failed with status: %s", resp.Status)
	}
}

func getQR(w http.ResponseWriter, r *http.Request) {
	qrCodeMutex.RLock()
	defer qrCodeMutex.RUnlock()
	if qrCodeStr == "" {
		http.Error(w, "QR code not available", http.StatusNotFound)
		return
	}
	// For simplicity, returning the string. The gateway could convert this to an image.
	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprint(w, qrCodeStr)
}

type sendMessageRequest struct {
	To   string `json:"to"`
	Text string `json:"text"`
}

func parseJID(arg string) (types.JID, bool) {
	if arg[0] == '+' {
		arg = arg[1:]
	}
	if !strings.ContainsRune(arg, '@') {
		return types.NewJID(arg, types.DefaultUserServer), true
	}
	recipient, err := types.ParseJID(arg)
	if err != nil {
		log.Errorf("Invalid JID %s: %v", arg, err)
		return recipient, false
	} else if recipient.User == "" {
		log.Errorf("Invalid JID %s: no user specified", arg)
		return recipient, false
	}
	return recipient, true
}

func sendText(w http.ResponseWriter, r *http.Request) {
	if client == nil || !client.IsConnected() {
		http.Error(w, "Client not connected", http.StatusServiceUnavailable)
		return
	}

	var reqBody sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	recipient, ok := parseJID(reqBody.To)
	if !ok {
		http.Error(w, fmt.Sprintf("Invalid JID: %s", reqBody.To), http.StatusBadRequest)
		return
	}

	msg := &types.Message{
		Conversation: proto.String(reqBody.Text),
	}

	ts, err := client.SendMessage(context.Background(), recipient, msg)
	if err != nil {
		log.Errorf("Error sending message: %v", err)
		http.Error(w, "Failed to send message", http.StatusInternalServerError)
		return
	}

	log.Infof("Message sent to %s (ID: %s, Timestamp: %s)", recipient.String(), ts.ID, ts.Timestamp)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "id": ts.ID})
}

func startAPIServer() {
	http.HandleFunc("/qr", getQR)
	http.HandleFunc("/send", sendText)
	log.Infof("Starting internal API server on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatalf("API server failed: %v", err)
	}
}

func main() {
	log = waLog.Stdout("main", "INFO", true)
	dbLog := waLog.Stdout("Database", "INFO", true)

	container, err := sqlstore.New("sqlite3", "file:/session/whatsmeow.db?_foreign_keys=on", dbLog)
	if err != nil {
		panic(err)
	}
	deviceStore, err := container.GetFirstDevice()
	if err != nil {
		panic(err)
	}

	client = whatsmeow.NewClient(deviceStore, log)
	client.AddEventHandler(eventHandler)

	go startAPIServer()

	if client.Store.ID == nil {
		qrChan, _ := client.GetQRChannel(context.Background())
		err = client.Connect()
		if err != nil {
			panic(err)
		}
		for evt := range qrChan {
			if evt.Event == "code" {
				qrCodeMutex.Lock()
				qrCodeStr = evt.Code
				qrCodeMutex.Unlock()
				// Also print to console for debugging
				qr, _ := qrcode.New(evt.Code, qrcode.Medium)
				fmt.Println("QR code:\n" + qr.ToString(true))
			} else {
				log.Infof("Login event: %s", evt.Event)
				if evt.Event == "success" {
					qrCodeMutex.Lock()
					qrCodeStr = "" // Clear QR code after login
					qrCodeMutex.Unlock()
				}
			}
		}
	} else {
		err = client.Connect()
		if err != nil {
			panic(err)
		}
	}

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c

	client.Disconnect()
}
````

## File: .env.example
````
DATABASE_URL="postgresql://user:password@localhost:5432/whatsapp_gateway"
API_SECRET="your-super-secret-api-key"
````

## File: drizzle.config.ts
````typescript
import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export default defineConfig({
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
});
````

## File: package.json
````json
{
  "name": "whatsapp-gateway-saas",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "gateway"
  ],
  "scripts": {
    "dev": "bun --cwd gateway run dev",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "devDependencies": {
    "drizzle-kit": "latest",
    "dotenv": "latest"
  }
}
````

## File: README.md
````markdown
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
````

## File: user.prompt.md
````markdown
====

understand readme.md then plan! proritize the whatsmeow provider first
````
