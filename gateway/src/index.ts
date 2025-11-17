import { Elysia, t } from 'elysia';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../../drizzle/schema';
import { createAndStartContainer, findContainer, stopAndRemoveContainer } from './docker.service';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });

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
    // Resolve user from API Key
    .resolve(async ({ headers }) => {
        const auth = headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) {
            return { user: null };
        }
        const apiKey = auth.substring(7);
        if (!apiKey) {
            return { user: null };
        }
        const [user] = await db.select().from(schema.users).where(eq(schema.users.apiKey, apiKey));
        
        return { user: user || null };
    })
    // Simple bearer token auth
    .onBeforeHandle(({ user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: 'Unauthorized' };
        }
    })
    .post('/instances', async ({ body, set, user }) => {
        // user is guaranteed to be non-null by the onBeforeHandle guard.
        const [newInstance] = await db.insert(schema.instances).values({
            userId: user.id, 
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
                provider: newInstance.provider,
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
            provider: t.Union([
                t.Literal('whatsmeow'),
                t.Literal('baileys'),
                t.Literal('wawebjs'),
                t.Literal('waba')
            ]),
            webhook: t.Optional(t.String()),
            resources: t.Optional(t.Object({
                cpu: t.String(),
                memory: t.String(),
            }))
        })
    })
    .get('/instances/:id/qr', async ({ params, set, user }) => {
        const instanceId = parseInt(params.id, 10);

        // Ownership check
        const [instance] = await db.select().from(schema.instances).where(eq(schema.instances.id, instanceId));
        if (!instance) {
            set.status = 404;
            return { error: 'Instance not found' };
        }
        if (instance.userId !== user.id) {
            set.status = 403;
            return { error: 'Forbidden' };
        }
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
    .post('/instances/:id/send', async ({ params, body, set, user }) => {
        const instanceId = parseInt(params.id, 10);

        // Ownership check
        const [instance] = await db.select().from(schema.instances).where(eq(schema.instances.id, instanceId));
        if (!instance) {
            set.status = 404;
            return { error: 'Instance not found' };
        }
        if (instance.userId !== user.id) {
            set.status = 403;
            return { error: 'Forbidden' };
        }
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
    .delete('/instances/:id', async ({ params, set, user }) => {
        const instanceId = parseInt(params.id, 10);

        // Ownership check
        const [instance] = await db.select({ userId: schema.instances.userId }).from(schema.instances).where(eq(schema.instances.id, instanceId));
        if (!instance) {
            set.status = 404;
            return { error: 'Instance not found' };
        }
        if (instance.userId !== user.id) {
            set.status = 403;
            return { error: 'Forbidden' };
        }

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
  // New internal API group for state management
  .group('/internal', (app) => app
    .onBeforeHandle(({ headers, set }) => {
        const internalSecret = process.env.INTERNAL_API_SECRET;
        if (!internalSecret) {
            console.error('INTERNAL_API_SECRET is not set. Internal API is disabled.');
            set.status = 503;
            return { error: 'Service Unavailable' };
        }
        if (headers['x-internal-secret'] !== internalSecret) {
            set.status = 401;
            return { error: 'Unauthorized' };
        }
    })
    .get('/state/:instanceId', async ({ params }) => {
        const instanceId = parseInt(params.instanceId, 10);
        const states = await db.select({
            key: schema.instanceState.key,
            value: schema.instanceState.value
        }).from(schema.instanceState).where(eq(schema.instanceState.instanceId, instanceId));
        
        return states;
    })
    .get('/state/:instanceId/:key', async ({ params, set }) => {
        const instanceId = parseInt(params.instanceId, 10);
        const [state] = await db.select({
            value: schema.instanceState.value
        }).from(schema.instanceState).where(and(
            eq(schema.instanceState.instanceId, instanceId),
            eq(schema.instanceState.key, params.key)
        ));

        if (!state) {
            set.status = 404;
            return { error: 'State key not found' };
        }
        return state.value; // Return raw value
    })
    .post('/state/:instanceId', async ({ params, body, set }) => {
        const instanceId = parseInt(params.instanceId, 10);
        const { key, value } = body;
        
        await db.insert(schema.instanceState)
            .values({ instanceId, key, value })
            .onConflictDoUpdate({
                target: [schema.instanceState.instanceId, schema.instanceState.key],
                set: { value: value }
            });
        
        set.status = 204;
    }, {
        body: t.Object({
            key: t.String(),
            value: t.String(),
        })
    })
    .delete('/state/:instanceId/:key', async ({ params, set }) => {
        const instanceId = parseInt(params.instanceId, 10);
        const result = await db.delete(schema.instanceState).where(and(
            eq(schema.instanceState.instanceId, instanceId),
            eq(schema.instanceState.key, params.key)
        )).returning();

        if (result.length === 0) {
            set.status = 404;
            return { error: 'State key not found' };
        }
        
        set.status = 204;
    })
    .get('/state/:instanceId/snapshot', async ({ params, set }) => {
        const instanceId = parseInt(params.instanceId, 10);
        const [state] = await db.select({
            value: schema.instanceState.value
        }).from(schema.instanceState).where(and(
            eq(schema.instanceState.instanceId, instanceId),
            eq(schema.instanceState.key, 'session_snapshot')
        ));

        if (!state || !state.value) {
            set.status = 404;
            return { error: 'Snapshot not found' };
        }
        // The value is base64 encoded text, decode it and return as binary
        set.headers['Content-Type'] = 'application/octet-stream';
        return Buffer.from(state.value, 'base64');
    })
    .post('/state/:instanceId/snapshot', async ({ params, body, set }) => {
        const instanceId = parseInt(params.instanceId, 10);

        // The body is raw bytes, we need to base64 encode it for storing in text field
        let bodyBuffer: Buffer;
        if (body instanceof ReadableStream) {
            bodyBuffer = await new Response(body).arrayBuffer().then(buf => Buffer.from(buf));
        } else if (Buffer.isBuffer(body)) {
            bodyBuffer = body;
        } else if (typeof body === 'string') {
            bodyBuffer = Buffer.from(body, 'utf-8');
        } else {
            bodyBuffer = Buffer.from(JSON.stringify(body), 'utf-8');
        }
        const value = bodyBuffer.toString('base64');

        await db.insert(schema.instanceState)
            .values({ instanceId, key: 'session_snapshot', value })
            .onConflictDoUpdate({
                target: [schema.instanceState.instanceId, schema.instanceState.key],
                set: { value: value }
            });

        set.status = 204;
    }, {
        // Allow any content type as we are reading the raw body
        type: 'none',
        body: t.Any(),
    })
  )
  .listen(3000);

console.log(
  `🦊 Gateway is running at ${app.server?.hostname}:${app.server?.port}`
);