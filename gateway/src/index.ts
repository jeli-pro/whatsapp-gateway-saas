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