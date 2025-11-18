# Directory Structure
```
drizzle/
  package.json
  schema.ts
  tsconfig.json
gateway/
  src/
    app.ts
    docker.client.ts
    docker.service.ts
    index.ts
  tests/
    e2e/
      .gitkeep
      instance-interaction.test.ts
      instances.test.ts
      migration.test.ts
      nodes.test.ts
      state.test.ts
    helpers/
      setup.ts
    integration/
      .gitkeep
    unit/
      .gitkeep
      docker.service.test.ts
    utils/
      test-setup.ts
    setup.ts
  .eslintrc.cjs
  package.json
  tsconfig.json
providers/
  whatsmeow/
    .env.example
    challenges.log.md
    docker-compose.yml
    Dockerfile
    go.mod
    main.go
.env.example
.env.test
docker-compose.test.yml
docker-compose.worker.yml
drizzle.config.ts
package.json
README.md
tsconfig.base.json
tsconfig.json
```

# Files

## File: gateway/tests/e2e/instance-interaction.test.ts
````typescript
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { db, setup, teardown, cleanupDb, cleanupContainers, TEST_USER_API_KEY, findContainerByInstanceId, type User, type Node } from '../helpers/setup';

describe('E2E - Instance Interaction API', () => {
    let serverUrl: string;
    let appInstance: any;
    let testUser: User;
    let testNode: Node;

    beforeAll(async () => {
        const setupResult = await setup();
        serverUrl = setupResult.serverUrl;
        appInstance = setupResult.app;
        testUser = setupResult.user;
        testNode = setupResult.nodes[0];
    });

    afterAll(async () => {
        await cleanupContainers();
        if (appInstance) {
            await teardown(appInstance);
        }
    });

    afterEach(async () => {
        await cleanupContainers();
        await cleanupDb();
    });

    test('should get a QR code for a new instance', async () => {
        // Create instance
        const createResponse = await fetch(`${serverUrl}/api/instances`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEST_USER_API_KEY}` },
            body: JSON.stringify({ provider: "whatsmeow", phone: "111222333" }),
        });
        expect(createResponse.status).toBe(200);
        const instance = await createResponse.json() as { id: number };

        // Wait for container to be ready and generate QR
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get QR code
        const qrResponse = await fetch(`${serverUrl}/api/instances/${instance.id}/qr`, {
            headers: { 'Authorization': `Bearer ${TEST_USER_API_KEY}` }
        });

        expect(qrResponse.status).toBe(200);
        expect(qrResponse.headers.get('content-type')).toBe('image/png');
        const qrBlob = await qrResponse.blob();
        expect(qrBlob.size).toBeGreaterThan(0);
    }, 15000);

    test('should fail to send a message from an unpaired instance', async () => {
        const createResponse = await fetch(`${serverUrl}/api/instances`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEST_USER_API_KEY}` },
            body: JSON.stringify({ provider: "whatsmeow", phone: "444555666" }),
        });
        expect(createResponse.status).toBe(200);
        const instance = await createResponse.json() as { id: number };
        
        await new Promise(resolve => setTimeout(resolve, 3000)); // wait for container start

        const sendResponse = await fetch(`${serverUrl}/api/instances/${instance.id}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEST_USER_API_KEY}` },
            body: JSON.stringify({ to: '12345', text: 'hello' }),
        });
        
        // whatsmeow returns 503 if not connected. The gateway proxies this.
        expect(sendResponse.status).toBe(503); 
        const body = await sendResponse.json() as { error: string };
        expect(body.error).toBe("Client not connected");
    }, 15000);
});
````

## File: gateway/tests/e2e/migration.test.ts
````typescript
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { db, setup, teardown, cleanupDb, cleanupContainers, TEST_USER_API_KEY, findContainerByInstanceId, type User, type Node, type Instance } from '../helpers/setup';
import * as schema from '../../../drizzle/schema';
import { eq } from 'drizzle-orm';

describe('E2E - Instance Migration API', () => {
    let serverUrl: string;
    let appInstance: any;
    let testUser: User;
    let nodes: Node[];

    beforeAll(async () => {
        const setupResult = await setup({ nodeCount: 2 });
        serverUrl = setupResult.serverUrl;
        appInstance = setupResult.app;
        testUser = setupResult.user;
        nodes = setupResult.nodes;
    }, 30000);

    afterAll(async () => {
        await cleanupContainers();
        if (appInstance) {
            await teardown(appInstance);
        }
    });

    afterEach(async () => {
        await cleanupContainers();
        await cleanupDb();
    });

    test('should migrate an instance from one node to another', async () => {
        expect(nodes.length).toBe(2);
        const [node1, node2] = nodes;

        // 1. Create an instance. It should be scheduled on the first available node (node1).
        const createResponse = await fetch(`${serverUrl}/api/instances`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEST_USER_API_KEY}` },
            body: JSON.stringify({ provider: "whatsmeow", phone: "mig-test-123" }),
        });
        expect(createResponse.status).toBe(200);
        const instance = await createResponse.json() as { id: number; nodeId: number };
        const instanceId = instance.id;

        // 2. Verify it's on node1 in the DB and a container is running.
        let dbInstance = await db.query.instances.findFirst({ where: eq(schema.instances.id, instanceId) });
        expect(dbInstance).toBeDefined();
        expect(dbInstance?.nodeId).toBe(node1.id);
        
        const containerBefore = await findContainerByInstanceId(instanceId);
        expect(containerBefore).toBeDefined();
        expect(containerBefore?.State).toBe('running');

        // 3. Trigger migration.
        const migrateResponse = await fetch(`${serverUrl}/api/instances/${instanceId}/migrate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TEST_USER_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_node: 'any' })
        });
        expect(migrateResponse.status).toBe(200);
        const migrateResult = await migrateResponse.json() as { status: string; instance: Instance };
        expect(migrateResult.status).toBe('ok');
        expect(migrateResult.instance.nodeId).toBe(node2.id);

        // 4. Verify it's now on node2 in the DB.
        dbInstance = await db.query.instances.findFirst({ where: eq(schema.instances.id, instanceId) });
        expect(dbInstance).toBeDefined();
        expect(dbInstance?.nodeId).toBe(node2.id);

        // 5. Verify a new container is running.
        const containerAfter = await findContainerByInstanceId(instanceId);
        expect(containerAfter).toBeDefined();
        expect(containerAfter?.State).toBe('running');
        expect(containerAfter?.Id).not.toBe(containerBefore?.Id); // Should be a new container

    }, 30000); // Migration can take time (stop, pull, start)
});
````

## File: gateway/tests/e2e/nodes.test.ts
````typescript
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { db, setup, teardown, cleanupDb, createTestInstance, TEST_ADMIN_API_SECRET, type User, type Node } from '../helpers/setup';
import * as schema from '../../../drizzle/schema';
import { eq, ne } from 'drizzle-orm';

describe('E2E - Admin Node Management API', () => {
    let serverUrl: string;
    let appInstance: any;
    let testUser: User;
    let initialNode: Node;

    beforeAll(async () => {
        const setupResult = await setup(); // Sets up 1 initial node
        serverUrl = setupResult.serverUrl;
        appInstance = setupResult.app;
        testUser = setupResult.user;
        initialNode = setupResult.nodes[0];
    });

    afterAll(async () => {
        if (appInstance) {
            await teardown(appInstance);
        }
    });

    afterEach(async () => {
        // Clean up any instances created during tests
        await cleanupDb();
        
        // Clean up any nodes created during tests, leaving the initial one
        await db.delete(schema.nodes).where(ne(schema.nodes.id, initialNode.id));
    });

    test('should reject access without the admin secret', async () => {
        const res = await fetch(`${serverUrl}/admin/nodes`);
        expect(res.status).toBe(401);

        const postRes = await fetch(`${serverUrl}/admin/nodes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'node-x', dockerHost: 'host', publicHost: 'public' })
        });
        expect(postRes.status).toBe(401);
    });

    test('should create, list, get, update, and delete a node', async () => {
        const newNodeData = {
            name: 'test-node-2',
            dockerHost: 'unix:///var/run/docker.sock',
            publicHost: 'test-node-2.local'
        };

        // 1. Create Node
        const createResponse = await fetch(`${serverUrl}/admin/nodes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-API-Secret': TEST_ADMIN_API_SECRET
            },
            body: JSON.stringify(newNodeData)
        });
        expect(createResponse.status).toBe(200);
        const createdNode = await createResponse.json() as Node;
        expect(createdNode.id).toBeTypeOf('number');
        expect(createdNode.name).toBe(newNodeData.name);

        const nodeId = createdNode.id;

        // 2. List Nodes
        const listResponse = await fetch(`${serverUrl}/admin/nodes`, {
            headers: { 'X-Admin-API-Secret': TEST_ADMIN_API_SECRET }
        });
        expect(listResponse.status).toBe(200);
        const nodes = await listResponse.json() as Node[];
        expect(nodes.length).toBe(2); // Initial node + new node
        expect(nodes.find(n => n.id === nodeId)).toBeDefined();

        // 3. Get Node by ID
        const getResponse = await fetch(`${serverUrl}/admin/nodes/${nodeId}`, {
            headers: { 'X-Admin-API-Secret': TEST_ADMIN_API_SECRET }
        });
        expect(getResponse.status).toBe(200);
        const fetchedNode = await getResponse.json() as Node;
        expect(fetchedNode.id).toBe(nodeId);
        expect(fetchedNode.name).toBe(newNodeData.name);

        // 4. Update Node
        const updatedName = 'test-node-2-updated';
        const updateResponse = await fetch(`${serverUrl}/admin/nodes/${nodeId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-API-Secret': TEST_ADMIN_API_SECRET
            },
            body: JSON.stringify({ name: updatedName })
        });
        expect(updateResponse.status).toBe(200);
        const updatedNode = await updateResponse.json() as Node;
        expect(updatedNode.name).toBe(updatedName);

        // 5. Delete Node
        const deleteResponse = await fetch(`${serverUrl}/admin/nodes/${nodeId}`, {
            method: 'DELETE',
            headers: { 'X-Admin-API-Secret': TEST_ADMIN_API_SECRET }
        });
        expect(deleteResponse.status).toBe(204);

        // 6. Verify Deletion
        const getAfterDeleteResponse = await fetch(`${serverUrl}/admin/nodes/${nodeId}`, {
            headers: { 'X-Admin-API-Secret': TEST_ADMIN_API_SECRET }
        });
        expect(getAfterDeleteResponse.status).toBe(404);
    });

    test('should return 409 Conflict when deleting a node with active instances', async () => {
        // The initialNode from setup is our target
        const nodeToDelete = initialNode;

        // 1. Create an instance assigned to this node
        const testInstance = await createTestInstance(db, testUser, nodeToDelete);
        expect(testInstance.nodeId).toBe(nodeToDelete.id);

        // 2. Attempt to delete the node
        const deleteResponse = await fetch(`${serverUrl}/admin/nodes/${nodeToDelete.id}`, {
            method: 'DELETE',
            headers: { 'X-Admin-API-Secret': TEST_ADMIN_API_SECRET }
        });
        
        // 3. Assert a 409 Conflict response
        expect(deleteResponse.status).toBe(409);
        const errorBody = await deleteResponse.json() as { error: string };
        expect(errorBody.error).toBe('Cannot delete node because it has instances assigned to it.');

        // 4. Verify the node still exists in the database
        const getNodeResponse = await fetch(`${serverUrl}/admin/nodes/${nodeToDelete.id}`, {
            headers: { 'X-Admin-API-Secret': TEST_ADMIN_API_SECRET }
        });
        expect(getNodeResponse.status).toBe(200);
    });
});
````

## File: .env.test
````
DATABASE_URL="postgresql://test_user:test_password@localhost:5433/test_db"
API_SECRET="test-api-key-secret-for-ci"
INTERNAL_API_SECRET="test-internal-secret-for-ci"
ADMIN_API_SECRET="test-admin-secret-for-ci"
GATEWAY_URL="http://host.docker.internal:3000"
````

## File: drizzle/package.json
````json
{
  "name": "@whatsapp-gateway-saas/drizzle",
  "private": true
}
````

## File: drizzle/tsconfig.json
````json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "noEmit": false
  },
  "include": ["schema.ts"]
}
````

## File: gateway/src/app.ts
````typescript
import { Elysia, t } from 'elysia';
import { eq, and, not } from 'drizzle-orm';
import * as schema from '../../drizzle/schema';
import { createAndStartContainer, stopAndRemoveContainer, type WorkerNode } from './docker.service';

/**
 * Creates the Elysia app instance with all routes configured.
 * Database connection is injected to avoid circular dependencies in tests.
 */
export function createApp(db: any) {
  // A simple proxy to fetch data from an instance via its public URL
  async function proxyToInstance(instanceUrl: string, options?: RequestInit) {
    try {
      const response = await fetch(instanceUrl, options);
      return response;
    } catch (e) {
      console.error(`Failed to proxy request to ${instanceUrl}`, e);
      return null;
    }
  }

  return new Elysia()
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
        // Select a node for the new instance. Simple round-robin or first-available logic.
        // For now, just pick the first one.
        const [node] = await db.select().from(schema.nodes).limit(1);
        if (!node) {
          set.status = 503;
          return { error: 'No available worker nodes to schedule instance.' };
        }

        // user is guaranteed to be non-null by the onBeforeHandle guard.
        const [newInstance] = await db.insert(schema.instances).values({
          nodeId: node.id,
          userId: user!.id,
          name: body.name,
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
            node: node,
            name: newInstance.name,
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
          name: t.Optional(t.String()),
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

        // Ownership check and fetch instance with its node
        const [instanceData] = await db.select().from(schema.instances).where(and(eq(schema.instances.id, instanceId), eq(schema.instances.userId, user!.id))).leftJoin(schema.nodes, eq(schema.instances.nodeId, schema.nodes.id));

        if (!instanceData || !instanceData.instances) {
          set.status = 404;
          return { error: 'Instance not found' };
        }
        if (!instanceData.nodes) {
          set.status = 500;
          return { error: 'Instance is not associated with a node.' };
        }

        const instanceUrl = `http://${instanceData.nodes.publicHost}/instances/${instanceId}/qr`;
        const qrResponse = await proxyToInstance(instanceUrl);
        if (!qrResponse) {
          set.status = 503;
          return { error: "Failed to connect to instance container." };
        }
        if (!qrResponse.ok) {
          set.status = qrResponse.status;
          return qrResponse.body;
        }

        // The whatsmeow provider returns a PNG. We need to proxy that correctly.
        set.headers['Content-Type'] = qrResponse.headers.get('Content-Type') || 'image/png';
        return qrResponse.blob();
      })
      .post('/instances/:id/send', async ({ params, body, set, user }) => {
        const instanceId = parseInt(params.id, 10);

        // Ownership check
        const [instanceData] = await db.select().from(schema.instances).where(and(eq(schema.instances.id, instanceId), eq(schema.instances.userId, user!.id))).leftJoin(schema.nodes, eq(schema.instances.nodeId, schema.nodes.id));
        if (!instanceData || !instanceData.instances) {
          set.status = 404;
          return { error: 'Instance not found' };
        }
        if (!instanceData.nodes) {
          set.status = 500;
          return { error: 'Instance is not associated with a node.' };
        }

        const instanceUrl = `http://${instanceData.nodes.publicHost}/instances/${instanceId}/send`;

        const sendResponse = await proxyToInstance(instanceUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!sendResponse) {
          set.status = 503;
          return { error: "Failed to connect to instance container." };
        }
        set.status = sendResponse.status;
        if (!sendResponse.ok) {
          const errorText = await sendResponse.text();
          try {
            return JSON.parse(errorText);
          } catch (e) {
            return { error: errorText.trim() };
          }
        }
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
        const [instanceData] = await db.select().from(schema.instances).where(and(eq(schema.instances.id, instanceId), eq(schema.instances.userId, user!.id))).leftJoin(schema.nodes, eq(schema.instances.nodeId, schema.nodes.id));
        if (!instanceData || !instanceData.instances) {
          set.status = 404;
          return { error: 'Instance not found' };
        }
        if (!instanceData.nodes) {
          // Instance exists but node doesn't. Clean up DB record.
          await db.delete(schema.instances).where(eq(schema.instances.id, instanceId));
          return { message: 'Instance found without a node. Record cleaned up.' };
        }

        try {
          await stopAndRemoveContainer(instanceId, instanceData.nodes);
          await db.delete(schema.instances).where(eq(schema.instances.id, instanceId));
          set.status = 204;
        } catch (error) {
          console.error('Failed to delete instance:', error);
          set.status = 500;
          return { error: 'Failed to delete instance' };
        }
      })
      .post('/instances/:id/migrate', async ({ params, set, user, body }) => {
        // The `target_node` from the README is ignored in this single-node implementation.
        const instanceId = parseInt(params.id, 10);

        // 1. Ownership check
        const [instanceData] = await db.select().from(schema.instances).where(and(eq(schema.instances.id, instanceId), eq(schema.instances.userId, user!.id))).leftJoin(schema.nodes, eq(schema.instances.nodeId, schema.nodes.id));
        if (!instanceData || !instanceData.instances || !instanceData.nodes) {
          set.status = 404;
          return { error: 'Instance not found or you do not have permission to access it' };
        }

        const instance = instanceData.instances;
        const currentNode = instanceData.nodes;

        // Find a new node to migrate to
        const [newNode] = await db.select().from(schema.nodes).where(not(eq(schema.nodes.id, currentNode.id))).limit(1);
        if (!newNode) {
          set.status = 503;
          return { error: 'No available node to migrate to.' };
        }

        console.log(`Starting migration for instance ${instanceId} from node ${currentNode.name} to ${newNode.name}`);

        try {
          // 2. Set status to 'migrating'
          await db.update(schema.instances).set({ status: 'migrating' }).where(eq(schema.instances.id, instanceId));

          // 3. Stop and remove the old container. This triggers the snapshot upload on the provider.
          await stopAndRemoveContainer(instanceId, currentNode);
          console.log(`Old container for instance ${instanceId} removed from node ${currentNode.name}.`);

          // 4. Create and start a new container. The provider will fetch the snapshot on startup.
          await createAndStartContainer({
            instanceId: instance.id,
            node: newNode,
            name: instance.name,
            webhookUrl: instance.webhookUrl || '',
            cpuLimit: instance.cpuLimit || '0.5',
            memoryLimit: instance.memoryLimit || '512m',
            provider: instance.provider,
          });
          console.log(`New container for instance ${instanceId} started on node ${newNode.name}.`);

          // 5. Set status back to 'running'
          const [updatedInstance] = await db.update(schema.instances).set({
            status: 'running',
            nodeId: newNode.id,
          })
            .where(eq(schema.instances.id, instanceId))
            .returning();

          console.log(`Migration for instance ${instanceId} completed successfully.`);
          return { status: 'ok', instance: updatedInstance };
        } catch (error) {
          console.error(`Migration failed for instance ${instanceId}:`, error);
          await db.update(schema.instances).set({ status: 'error' }).where(eq(schema.instances.id, instanceId));
          set.status = 500;
          return { error: 'Migration failed' };
        }
      }, {
        body: t.Object({
          target_node: t.Optional(t.String()),
        })
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
        const valueAsBuffer = Buffer.from(value);

        await db.insert(schema.instanceState)
          .values({ instanceId, key, value: valueAsBuffer })
          .onConflictDoUpdate({
            target: [schema.instanceState.instanceId, schema.instanceState.key],
            set: { value: valueAsBuffer }
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
        // The value is a buffer from the bytea column
        set.headers['Content-Type'] = 'application/octet-stream';
        return state.value;
      })
      .post('/state/:instanceId/snapshot', async ({ params, body, set }) => {
        const instanceId = parseInt(params.instanceId, 10);

        // Body is an ArrayBuffer, convert it to a Buffer for the DB driver
        const value = Buffer.from(body);

        await db.insert(schema.instanceState)
          .values({ instanceId: instanceId, key: 'session_snapshot', value })
          .onConflictDoUpdate({
            target: [schema.instanceState.instanceId, schema.instanceState.key],
            set: { value }
          });

        set.status = 204;
      }, { body: t.ArrayBuffer() })
    )
    // New admin API group for node management
    .group('/admin', (app) => app
      .onBeforeHandle(({ headers, set }) => {
        const adminSecret = process.env.ADMIN_API_SECRET;
        if (!adminSecret) {
          console.error('ADMIN_API_SECRET is not set. Admin API is disabled.');
          set.status = 503;
          return { error: 'Service Unavailable' };
        }
        if (headers['x-admin-api-secret'] !== adminSecret) {
          set.status = 401;
          return { error: 'Unauthorized' };
        }
      })
      .post('/nodes', async ({ body, set }) => {
        const [newNode] = await db.insert(schema.nodes).values(body).returning();
        if (!newNode) {
          set.status = 500;
          return { error: 'Failed to create node' };
        }
        return newNode;
      }, {
        body: t.Object({
          name: t.String(),
          dockerHost: t.String(),
          publicHost: t.String(),
        })
      })
      .get('/nodes', async () => {
        return await db.select().from(schema.nodes);
      })
      .get('/nodes/:id', async ({ params, set }) => {
        const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, params.id));
        if (!node) {
          set.status = 404;
          return { error: 'Node not found' };
        }
        return node;
      }, {
        params: t.Object({ id: t.Numeric() })
      })
      .put('/nodes/:id', async ({ params, body, set }) => {
        const [updatedNode] = await db.update(schema.nodes)
          .set(body)
          .where(eq(schema.nodes.id, params.id))
          .returning();
        if (!updatedNode) {
          set.status = 404;
          return { error: 'Node not found' };
        }
        return updatedNode;
      }, {
        params: t.Object({ id: t.Numeric() }),
        body: t.Object({
          name: t.Optional(t.String()),
          dockerHost: t.Optional(t.String()),
          publicHost: t.Optional(t.String()),
        })
      })
      .delete('/nodes/:id', async ({ params, set }) => {
        try {
          const result = await db.delete(schema.nodes).where(eq(schema.nodes.id, params.id)).returning();
          if (result.length === 0) {
            set.status = 404;
            return { error: 'Node not found' };
          }
          set.status = 204;
        } catch (error: any) {
          // Check for foreign key violation (Postgres error code 23503). Drizzle might wrap it.
          if (error.code === '23503' || error?.cause?.code === '23503') {
            set.status = 409;
            return { error: 'Cannot delete node because it has instances assigned to it.' };
          }
          console.error('Failed to delete node:', error);
          set.status = 500;
          return { error: 'Internal server error' };
        }
      }, {
        params: t.Object({ id: t.Numeric() })
      })
    );
}
````

## File: gateway/src/docker.client.ts
````typescript
import { URL } from 'url';

// Simplified subset of Dockerode's ContainerInfo
export interface ContainerInfo {
    Id: string;
    Names: string[];
    Image: string;
    ImageID: string;
    Command: string;
    Created: number;
    State: string;
    Status: string;
    Ports: any[];
    Labels: Record<string, string>;
    SizeRw?: number;
    SizeRootFs?: number;
    HostConfig: {
        NetworkMode: string;
    };
    NetworkSettings: {
        Networks: any;
    };
    Mounts: any[];
}

export interface WorkerNode {
    id: number;
    dockerHost: string;
    publicHost: string;
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
    body?: any;
    headers?: Record<string, string>;
    json?: boolean;
}

class DockerClient {
    private socketPath?: string;
    private host?: string;
    private port?: number;

    constructor(node: Pick<WorkerNode, 'dockerHost'>) {
        if (node.dockerHost.startsWith('unix://') || node.dockerHost.startsWith('/')) {
            this.socketPath = node.dockerHost.replace('unix://', '');
        } else if (node.dockerHost.startsWith('tcp://')) {
            const parsedUrl = new URL(node.dockerHost);
            this.host = parsedUrl.hostname;
            this.port = parseInt(parsedUrl.port, 10);
        } else {
            const [host, port] = node.dockerHost.split(':');
            this.host = host;
            this.port = parseInt(port, 10);
        }
    }

    private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const method = options.method || 'GET';
        const headers = options.headers || {};

        let url: string;
        let fetchOptions: RequestInit = { method, headers };

        if (this.socketPath) {
            // Path must be absolute for unix socket fetch
            const absolutePath = path.startsWith('/') ? path : `/${path}`;
            url = `http://localhost${absolutePath}`;
            (fetchOptions as any).unix = this.socketPath;
        } else {
            url = `http://${this.host}:${this.port}${path}`;
        }
        
        if (options.body) {
            if (typeof options.body === 'object' && options.body !== null) {
                headers['Content-Type'] = 'application/json';
                fetchOptions.body = JSON.stringify(options.body);
            } else {
                fetchOptions.body = options.body;
            }
        }
        
        const res = await fetch(url, fetchOptions);

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`Docker API Error (${res.status} on ${method} ${path}): ${errorText}`);
            const error: any = new Error(`Docker API request failed: ${res.status} ${res.statusText}`);
            error.statusCode = res.status;
            error.reason = res.statusText;
            error.responseBody = errorText;
            throw error;
        }

        if (res.status === 204) {
            return null as T;
        }
        
        if (options.json === false) { // for streams
            return res as T;
        }

        return res.json() as Promise<T>;
    }
    
    // Equivalent of docker.listContainers
    async listContainers(options?: { all?: boolean, filters?: any }): Promise<ContainerInfo[]> {
        const params = new URLSearchParams();
        if (options?.all) {
            params.set('all', 'true');
        }
        if (options?.filters) {
            params.set('filters', JSON.stringify(options.filters));
        }
        return this.request(`/containers/json?${params.toString()}`);
    }

    // Equivalent of docker.createContainer
    async createContainer(options: any): Promise<{ Id: string, Warnings: string[] }> {
        const params = new URLSearchParams();
        if(options.name) {
            params.set('name', options.name);
        }
        return this.request(`/containers/create?${params.toString()}`, {
            method: 'POST',
            body: options,
        });
    }

    // Equivalent of container.start
    async startContainer(containerId: string): Promise<void> {
        await this.request(`/containers/${containerId}/start`, { method: 'POST' });
    }

    // Equivalent of container.stop
    async stopContainer(containerId: string, options?: { t?: number }): Promise<void> {
        const params = new URLSearchParams();
        if (options?.t) {
            params.set('t', options.t.toString());
        }
        await this.request(`/containers/${containerId}/stop?${params.toString()}`, { method: 'POST' });
    }

    // Equivalent of container.remove
    async removeContainer(containerId: string): Promise<void> {
        await this.request(`/containers/${containerId}`, { method: 'DELETE' });
    }

    // Equivalent of container.inspect
    async inspectContainer(containerId: string): Promise<any> {
        return this.request(`/containers/${containerId}/json`);
    }

    // Equivalent of docker.listImages
    async listImages(options?: { filters?: any }): Promise<any[]> {
        const params = new URLSearchParams();
        if (options?.filters) {
            params.set('filters', JSON.stringify(options.filters));
        }
        return this.request(`/images/json?${params.toString()}`);
    }

    // Equivalent of docker.pull
    async pullImage(imageName: string): Promise<Response> {
        const [image, tag] = imageName.split(':');
        const params = new URLSearchParams({ fromImage: image, tag: tag || 'latest' });
        // This returns a stream, so don't parse as JSON
        return this.request(`/images/create?${params.toString()}`, { method: 'POST', json: false });
    }
}

export function getDockerClientForNode(node: Pick<WorkerNode, 'dockerHost'>): DockerClient {
    return new DockerClient(node);
}
````

## File: gateway/tests/e2e/.gitkeep
````
// This file ensures the directory is tracked by git.
````

## File: gateway/tests/integration/.gitkeep
````
// This file ensures the directory is tracked by git.
````

## File: gateway/tests/unit/.gitkeep
````
// This file ensures the directory is tracked by git.
````

## File: gateway/tests/utils/test-setup.ts
````typescript
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from '../../../drizzle/schema';
import { promises as fs } from 'fs';

export interface TestEnvironment {
  DATABASE_URL: string;
  INTERNAL_API_SECRET: string;
  API_SECRET: string;
  ADMIN_API_SECRET: string;
  GATEWAY_URL: string;
  NODE_ENV: string;
}

let dbConnection: Sql | null = null;
let db: any = null;
let envFileCreated = false;
let migrationsRun = false;
let env: TestEnvironment | null = null;

export function getEnvironment(): TestEnvironment {
  if (!env) {
    throw new Error('Test environment is not initialized. Call ensureTestEnvironment() first.');
  }
  return env;
}

/**
 * Ensures the test environment is properly set up
 */
export async function ensureTestEnvironment(): Promise<TestEnvironment> {
  if (env) {
    return env;
  }
  console.log('🔧 Setting up test environment...');

  // Set up environment variables
  const testEnv = await setupEnvironment();

  // Start test database if needed
  await ensureTestDatabase();

  // Set up database schema
  await ensureDatabaseSchema();

  console.log('✅ Test environment ready');
  return testEnv;
}

/**
 * Sets up the test environment variables
 */
async function setupEnvironment(): Promise<TestEnvironment> {
  const testEnv: TestEnvironment = {
    DATABASE_URL: 'postgresql://test_user:test_password@localhost:5433/test_db',
    INTERNAL_API_SECRET: 'test-internal-secret-for-ci',
    API_SECRET: 'test-api-key-secret-for-ci',
    ADMIN_API_SECRET: 'test-admin-secret-for-ci',
    GATEWAY_URL: 'http://localhost:3000',
    NODE_ENV: 'test'
  };

  // Set environment variables
  Object.entries(testEnv).forEach(([key, value]) => {
    process.env[key] = value;
  });

  // Store for later retrieval
  env = testEnv;

  // Create .env.test file if it doesn't exist
  const gatewayDir = join(process.cwd());
  const envTestPath = join(gatewayDir, '.env.test');

  if (!existsSync(envTestPath)) {
    const envContent = Object.entries(testEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    await fs.writeFile(envTestPath, envContent);
    envFileCreated = true;
    console.log('📝 Created .env.test file');
  }

  return testEnv;
}

/**
 * Ensures test database is running and accessible
 */
async function ensureTestDatabase(): Promise<void> {
  console.log('🗄️  Checking test database...');

  try {
    // Try to connect to the database
    const client = postgres(process.env.DATABASE_URL!, { timeout: 5000 });
    await client`SELECT 1`;
    await client.end();
    console.log('✅ Test database is accessible');
    return;
  } catch (error) {
    console.log('⚠️  Test database not accessible, starting it...');
    await startTestDatabase();
  }
}

/**
 * Starts the test database using Docker
 */
async function startTestDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('🐳 Starting test database container...');

    // Stop existing container if it exists
    const stopCmd = spawn('docker', [
      'stop', 'whatsapp-gateway-saas-test-db'
    ], { stdio: 'pipe' });

    stopCmd.on('close', () => {
      const rmCmd = spawn('docker', [
        'rm', 'whatsapp-gateway-saas-test-db'
      ], { stdio: 'pipe' });

      rmCmd.on('close', () => {
        const runCmd = spawn('docker', [
          'run', '-d',
          '--name', 'whatsapp-gateway-saas-test-db',
          '-e', 'POSTGRES_USER=test_user',
          '-e', 'POSTGRES_PASSWORD=test_password',
          '-e', 'POSTGRES_DB=test_db',
          '-p', '5433:5432',
          '--restart', 'unless-stopped',
          'postgres:16-alpine'
        ], { stdio: 'pipe' });

        runCmd.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Test database container started');
            waitForDatabase().then(resolve).catch(reject);
          } else {
            reject(new Error('Failed to start test database container'));
          }
        });

        runCmd.on('error', reject);
      });

      rmCmd.on('error', () => {
        // Container might not exist, which is fine
        console.log('ℹ️  No existing container to remove');
        const runCmd = spawn('docker', [
          'run', '-d',
          '--name', 'whatsapp-gateway-saas-test-db',
          '-e', 'POSTGRES_USER=test_user',
          '-e', 'POSTGRES_PASSWORD=test_password',
          '-e', 'POSTGRES_DB=test_db',
          '-p', '5433:5432',
          '--restart', 'unless-stopped',
          'postgres:16-alpine'
        ], { stdio: 'pipe' });

        runCmd.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Test database container started');
            waitForDatabase().then(resolve).catch(reject);
          } else {
            reject(new Error('Failed to start test database container'));
          }
        });

        runCmd.on('error', reject);
      });
    });

    stopCmd.on('error', () => {
      // Container might not exist, which is fine
      console.log('ℹ️  No existing container to stop');
    });
  });
}

/**
 * Waits for the database to be ready
 */
async function waitForDatabase(): Promise<void> {
  console.log('⏳ Waiting for database to be ready...');

  for (let i = 0; i < 30; i++) {
    try {
      const client = postgres(process.env.DATABASE_URL!, { timeout: 5000 });
      await client`SELECT 1`;
      await client.end();
      console.log('✅ Database is ready');
      return;
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  throw new Error('Database failed to become ready within 30 seconds');
}

/**
 * Ensures the database schema is set up
 */
async function ensureDatabaseSchema(): Promise<void> {
  if (migrationsRun) {
    return;
  }

  console.log('🗃️  Setting up database schema...');

  try {
    // Try to connect and check if tables exist
    await connectToDatabase();

    // Check if tables exist by trying to query one of them
    try {
      await db.query.users.findFirst();
      console.log('✅ Database schema already exists');
      migrationsRun = true;
      return;
    } catch (error) {
      // Tables don't exist, need to run migrations
      console.log('🔄 Database schema needs to be created');
    }

    // Run migrations
    await runMigrations();
    migrationsRun = true;
    console.log('✅ Database schema created successfully');

  } catch (error) {
    console.error('❌ Failed to set up database schema:', error);
    throw error;
  }
}

/**
 * Connects to the database
 */
async function connectToDatabase(): Promise<void> {
  if (dbConnection) {
    return;
  }

  dbConnection = postgres(process.env.DATABASE_URL!);
  db = drizzle(dbConnection, { schema });
}

/**
 * Runs database migrations
 */
async function runMigrations(): Promise<void> {
  console.log('📦 Running database migrations...');

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');

    // First, generate migrations if they don't exist
    const generateCmd = spawn('npx', ['drizzle-kit', 'generate'], {
      cwd: join(process.cwd(), '..'),
      stdio: 'pipe'
    });

    generateCmd.on('close', (code: number | null) => {
      if (code === 0) {
        console.log('✅ Migrations generated');

        // Then run the migrations
        const migrateCmd = spawn('npx', ['drizzle-kit', 'migrate'], {
          cwd: join(process.cwd(), '..'),
          stdio: 'pipe'
        });

        migrateCmd.on('close', (code: number | null) => {
          if (code === 0) {
            console.log('✅ Migrations applied successfully');
            resolve();
          } else {
            reject(new Error('Migration failed'));
          }
        });

        migrateCmd.on('error', reject);
      } else {
        reject(new Error('Migration generation failed'));
      }
    });

    generateCmd.on('error', reject);
  });
}

/**
 * Gets the database connection for tests
 */
export async function getDb() {
  if (!db) {
    await connectToDatabase();
  }
  return db;
}

/**
 * Cleans up the test environment
 */
export async function cleanup(): Promise<void> {
  console.log('🧹 Cleaning up test environment...');

  if (dbConnection) {
    try {
      await dbConnection.end({ timeout: 5 });
      dbConnection = null;
      db = null;
    } catch (error) {
      console.warn('⚠️  Failed to close database connection:', error);
    }
  }

  if (envFileCreated) {
    try {
      const gatewayDir = join(process.cwd());
      const envTestPath = join(gatewayDir, '.env.test');
      await fs.unlink(envTestPath);
      console.log('🗑️  Removed .env.test file');
      envFileCreated = false; // Reset for next test run
    } catch (error) {
      console.warn('⚠️  Failed to remove .env.test file:', error);
    }
  }

  // Only clean up database container if explicitly requested or no other tests are running
  // This prevents cleanup conflicts when multiple test files are running
}

/**
 * Force cleanup of database container (for explicit cleanup only)
 */
export async function forceCleanup(): Promise<void> {
  console.log('🧹 Force cleaning up test environment...');

  if (dbConnection) {
    try {
      await dbConnection.end({ timeout: 5 });
      dbConnection = null;
      db = null;
    } catch (error) {
      console.warn('⚠️  Failed to close database connection:', error);
    }
  }

  if (envFileCreated) {
    try {
      const gatewayDir = join(process.cwd());
      const envTestPath = join(gatewayDir, '.env.test');
      await fs.unlink(envTestPath);
      console.log('🗑️  Removed .env.test file');
    } catch (error) {
      console.warn('⚠️  Failed to remove .env.test file:', error);
    }
  }

  // Stop test database container
  try {
    const { spawn } = require('child_process');
    const stopCmd = spawn('docker', ['stop', 'whatsapp-gateway-saas-test-db'], { stdio: 'pipe' });

    stopCmd.on('close', () => {
      const rmCmd = spawn('docker', ['rm', 'whatsapp-gateway-saas-test-db'], { stdio: 'pipe' });
      rmCmd.on('close', () => {
        console.log('✅ Test database container stopped and removed');
      });
    });
  } catch (error) {
    console.warn('⚠️  Failed to clean up test database container:', error);
  }
}
````

## File: gateway/tests/setup.ts
````typescript
import { beforeAll, afterAll } from 'bun:test';
import { ensureTestEnvironment, cleanup } from './utils/test-setup';

// Global setup for all tests
beforeAll(async () => {
  console.log('🚀 Setting up global test environment...');
  await ensureTestEnvironment();
}, 60000);

// Global cleanup after all tests
afterAll(async () => {
  console.log('🧹 Cleaning up global test environment...');
  await cleanup();
}, 30000);

// Handle unhandled promise rejections in tests
process.on('unhandledRejection', async (reason, promise) => {
  await cleanup();
});

// Handle uncaught exceptions in tests
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
````

## File: providers/whatsmeow/.env.example
````
# Application Configuration
VERSION=dev
BUILD_TIME=2025-01-01T00:00:00Z
COMPOSE_PROJECT_NAME=whatsmeow

# Network Configuration
PORT=8080
DOMAIN=localhost

# Resource Limits
CPU_LIMIT=0.5
CPU_RESERVATION=0.1
MEMORY_LIMIT=512M
MEMORY_RESERVATION=128M

# Application Settings
WEBHOOK_URL=
LOG_LEVEL=INFO

# Persistence
SESSION_VOLUME_PATH=./data/session
````

## File: providers/whatsmeow/challenges.log.md
````markdown
# Whatsmeow Provider Implementation - Challenges & Solutions Log

## Project Overview
Implementation of a production-ready Docker-based WhatsApp gateway provider using tulir/whatsmeow library.

## Challenges Encountered & Solutions

### 1. Initial Repository Structure Issues
**Challenge**: Started with incorrect directory structure - files were being created alongside source code instead of clean Docker-only setup.
**Solution**: Removed all source files (`src/` directory) and ensured only Docker-related files remained in the provider directory.

### 2. Go Module Version Conflicts
**Challenge**: Multiple attempts with incorrect Go module versions causing build failures:
- `go.mau.fi/whatsmeow v0.0.0-20241001005843-c891d22a3bc7` - invalid pseudo-version
- `go.mau.fi/whatsmeow v0.0.0-20250310142830-321653dc76a8` - invalid revision
**Solution**: Used correct commit hash and timestamp format: `v0.0.0-20251116104239-3aca43070cd4`

### 3. CGO vs Non-CGO SQLite Compilation
**Challenge**: Initial attempt with `CGO_ENABLED=0` failed due to SQLite3 requiring CGO.
**Solutions Attempted**:
1. **Modern SQLite Library**: Tried `modernc.org/sqlite` but caused memory issues
2. **CGO with Build Dependencies**: Added `gcc musl-dev` to builder stage
3. **Runtime Dependencies**: Added `sqlite` package to final stage
**Final Solution**: CGO_ENABLED=1 with proper build and runtime dependencies

### 4. Go Version Compatibility
**Challenge**: Multiple Go version conflicts:
- Go 1.21: Module required Go >= 1.24
- Go 1.23: Module required Go >= 1.24
- Go 1.24: Final working version
**Solution**: Updated Dockerfile to use `golang:1.24-alpine`

### 5. Database Path Issues
**Challenge**: SQLite database path errors:
- `file:/session/whatsmeow.db` - incorrect path
- `file:/app/session/whatsmeow.db` - correct path
**Solution**: Updated database connection string to use `/app/session/`

### 6. Directory Permissions
**Challenge**: SQLite database creation failed due to missing directories and permissions.
**Solution**: Added directory creation and permission setting in Dockerfile:
```dockerfile
RUN mkdir -p /app/session /app/logs && \
    chown -R appuser:appgroup /app && \
    chmod 755 /app/session
```

### 7. Container Memory Issues
**Challenge**: Container running out of memory during SQLite operations.
**Solution**: Increased container memory limit to 1GB during testing, but final implementation works with minimal memory (14MB).

### 8. Network Connectivity Issues
**Challenge**: Docker build failing due to network timeouts and registry issues.
**Solution**: Multiple retry attempts and using absolute paths for Docker context.

## Technical Decisions Made

### Database Choice
- **Selected**: `github.com/mattn/go-sqlite3` with CGO
- **Rejected**: `modernc.org/sqlite` (memory issues, compatibility problems)

### Go Version
- **Selected**: Go 1.24 (latest stable with module compatibility)
- **Rejected**: Go 1.21, 1.23 (module version conflicts)

### Build Strategy
- **Selected**: Multi-stage build with CGO support
- **Builder Stage**: golang:1.24-alpine + build dependencies
- **Runtime Stage**: Alpine 3.20 with minimal packages

### Security Model
- **Selected**: Non-root user with dedicated group
- **User**: `appuser` (UID 1001)
- **Group**: `appgroup` (GID 1001)
- **Working Dir**: `/app` with proper permissions

## Performance Metrics Achieved

### Memory Usage
- **Idle Container**: 14.27MB
- **With Runtime Overhead**: ~25-30MB
- **Final Image Size**: 44.3MB

### Startup Performance
- **Build Time**: ~2-3 minutes
- **Startup Time**: ~10 seconds to ready state
- **QR Generation**: ~3-5 seconds after startup

### API Response Times
- **Health Check**: <100ms
- **QR Code Generation**: <500ms
- **Database Operations**: <100ms

## Docker Implementation Details

### Multi-stage Build Optimization
1. **Builder Stage**: Compiles with CGO, includes build tools
2. **Runtime Stage**: Minimal Alpine with only required packages
3. **Layer Caching**: Optimized for CI/CD with proper .dockerignore

### Security Features
- Non-root user execution
- Minimal attack surface
- Volume-based persistence
- Health check monitoring

### Production Readiness
- Resource limits support
- Health check endpoints
- Structured logging
- Graceful shutdown handling

## API Endpoints Implemented

### Health & Status
- `GET /health` - Detailed health status
- `GET /status` - Alias for health endpoint

### WhatsApp Integration
- `GET /qr` - QR code PNG for WhatsApp pairing
- `POST /send` - Send text messages (JSON API)

### Event Handling
- Webhook support for message events
- Connection status notifications
- QR code generation events

## Configuration Management

### Environment Variables
- `PORT` - HTTP server port (default: 8080)
- `WEBHOOK_URL` - Event notification endpoint
- `LOG_LEVEL` - Logging verbosity
- `GOMAXPROCS` - Go runtime optimization

### Docker Compose Features
- Resource limits (CPU/MEM)
- Volume persistence
- Health check configuration
- Network isolation
- Environment templating

## Lessons Learned

### 1. CGO Complexity in Alpine
- Alpine's musl libc requires careful CGO configuration
- Build dependencies must be in builder stage
- Runtime dependencies needed in final stage
- Package naming differs between build/runtime

### 2. Go Module Versioning
- Pseudo-versions require exact commit timestamps
- Module compatibility constraints must be respected
- Go version requirements can be strict

### 3. SQLite in Containers
- Directory permissions are critical
- Path resolution must account for container filesystem
- Volume mounting for persistence is essential

### 4. Multi-stage Build Optimization
- Layer caching significantly improves CI/CD performance
- Dependency resolution should be cached separately
- Final image should be minimal for security

### 5. Production Docker Practices
- Non-root execution is mandatory for security
- Health checks enable proper orchestration
- Resource limits prevent noisy neighbor issues
- Structured logging aids monitoring and debugging

## Reproduction Checklist

For future implementations, ensure:
- [ ] Go module versions are exact matches
- [ ] CGO dependencies are properly configured
- [ ] Database paths use container filesystem structure
- [ ] Directory permissions are set correctly
- [ ] Non-root user has proper access to volumes
- [ ] Health checks are implemented and tested
- [ ] Resource limits are configured appropriately
- [ ] Security scanning is performed on final image

## Final Status: ✅ COMPLETE

All requirements fulfilled:
- ✅ Production-ready Docker implementation
- ✅ Working health and QR endpoints
- ✅ Optimal performance metrics achieved
- ✅ Security best practices implemented
- ✅ CI/CD pipeline compatibility
- ✅ Resource efficiency (14MB memory, 44MB image)
````

## File: docker-compose.test.yml
````yaml
version: "3.9"

services:
  postgres:
    image: postgres:16-alpine
    container_name: whatsapp-gateway-saas-test-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: test_user
      POSTGRES_PASSWORD: test_password
      POSTGRES_DB: test_db
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test_user -d test_db"]
      interval: 5s
      timeout: 5s
      retries: 5
````

## File: docker-compose.worker.yml
````yaml
version: "3.9"

services:
  traefik:
    image: "traefik:v3.0"
    container_name: "traefik"
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.myresolver.acme.httpchallenge=true"
      - "--certificatesresolvers.myresolver.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.myresolver.acme.email=${ACME_EMAIL:-your-email@example.com}" # Change this!
      - "--certificatesresolvers.myresolver.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
      # - "8080:8080" # Traefik Dashboard - uncomment if you need it, but be careful exposing it.
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "./letsencrypt:/letsencrypt"
    networks:
      - worker-net

networks:
  worker-net:
    driver: bridge
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

## File: gateway/tests/e2e/state.test.ts
````typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { db, setup, teardown, cleanupDb, createTestInstance, TEST_INTERNAL_API_SECRET, type User, type Node, type Instance } from '../helpers/setup';
import * as schema from '../../../drizzle/schema';
import { eq, and } from 'drizzle-orm';

describe('E2E - Internal State API', () => {
    let serverUrl: string;
    let testInstance: Instance;
    let testUser: User;
    let testNode: Node;
    let appInstance: any;

    beforeAll(async () => {
        const setupResult = await setup();
        serverUrl = setupResult.serverUrl;
        testUser = setupResult.user;
        testNode = setupResult.nodes[0];
        appInstance = setupResult.app;
    });

    afterAll(async () => {
        if (appInstance) {
            await teardown(appInstance);
        }
    });

    beforeEach(async () => {
        // Create a test instance record directly in the DB for these tests
        testInstance = await createTestInstance(db, testUser, testNode);
    });

    afterEach(async () => {
        await cleanupDb();
    });

    test('should reject access without the internal secret', async () => {
        const res = await fetch(`${serverUrl}/internal/state/${testInstance.id}/snapshot`);
        expect(res.status).toBe(401);

        const postRes = await fetch(`${serverUrl}/internal/state/${testInstance.id}/snapshot`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
            },
            body: Buffer.from('test data')
        });
        expect(postRes.status).toBe(401);
    });

    test('should upload and download a state snapshot', async () => {
        const instanceId = testInstance.id;
        const snapshotData = Buffer.from(`this is a binary test snapshot payload for instance ${instanceId}`);

        // 1. Upload Snapshot
        const uploadResponse = await fetch(`${serverUrl}/internal/state/${instanceId}/snapshot`, {
            method: 'POST',
            headers: {
                'X-Internal-Secret': TEST_INTERNAL_API_SECRET,
                'Content-Type': 'application/octet-stream',
            },
            body: snapshotData,
        });
        
        expect(uploadResponse.status).toBe(204);

        // 2. Verify the snapshot was saved correctly in the database
        const dbState = await db.query.instanceState.findFirst({
            where: and(
                eq(schema.instanceState.instanceId, instanceId),
                eq(schema.instanceState.key, 'session_snapshot')
            ),
        });
        expect(dbState).toBeDefined();
        expect(dbState?.value).toEqual(snapshotData);

        // 3. Download the snapshot
        const downloadResponse = await fetch(`${serverUrl}/internal/state/${instanceId}/snapshot`, {
            headers: { 'X-Internal-Secret': TEST_INTERNAL_API_SECRET }
        });

        expect(downloadResponse.status).toBe(200);
        expect(downloadResponse.headers.get('content-type')).toBe('application/octet-stream');
        
        const downloadedData = Buffer.from(await downloadResponse.arrayBuffer());
        expect(downloadedData).toEqual(snapshotData);

        // 4. Test GET for a non-existent snapshot returns 404
        const notFoundResponse = await fetch(`${serverUrl}/internal/state/999999/snapshot`, {
             headers: { 'X-Internal-Secret': TEST_INTERNAL_API_SECRET }
        });
        expect(notFoundResponse.status).toBe(404);
    });
});
````

## File: gateway/tests/unit/docker.service.test.ts
````typescript
import { describe, test, expect } from 'bun:test';
import { sanitizeForContainerName, parseMemory } from '../../src/docker.service';

describe('Docker Service Utilities', () => {
    describe('sanitizeForContainerName', () => {
        test('should convert to lowercase', () => {
            expect(sanitizeForContainerName('MyContainer')).toBe('mycontainer');
        });

        test('should replace spaces with hyphens', () => {
            expect(sanitizeForContainerName('my container name')).toBe('my-container-name');
        });

        test('should replace multiple special characters with a single hyphen', () => {
            expect(sanitizeForContainerName('my@#$container--_name')).toBe('my-container-_name');
        });

        test('should collapse consecutive hyphens', () => {
            expect(sanitizeForContainerName('my---container')).toBe('my-container');
        });

        test('should handle empty string', () => {
            expect(sanitizeForContainerName('')).toBe('');
        });

        test('should allow valid characters like dots and underscores', () => {
            expect(sanitizeForContainerName('my_container.v1')).toBe('my_container.v1');
        });
    });

    describe('parseMemory', () => {
        test('should parse megabytes (m)', () => {
            expect(parseMemory('512m')).toBe(512 * 1024 * 1024);
        });

        test('should parse gigabytes (g)', () => {
            expect(parseMemory('2g')).toBe(2 * 1024 * 1024 * 1024);
        });
        
        test('should parse kilobytes (k)', () => {
            expect(parseMemory('256k')).toBe(256 * 1024);
        });

        test('should handle uppercase units', () => {
            expect(parseMemory('512M')).toBe(512 * 1024 * 1024);
            expect(parseMemory('2G')).toBe(2 * 1024 * 1024 * 1024);
        });

        test('should return 0 for empty string', () => {
            expect(parseMemory('')).toBe(0);
        });

        test('should return 0 for invalid string', () => {
            expect(parseMemory('invalid')).toBe(0);
        });

        test('should treat number string as bytes', () => {
            expect(parseMemory('1024')).toBe(1024);
        });
    });
});
````

## File: gateway/.eslintrc.cjs
````
/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.json',
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { 'argsIgnorePattern': '^_' }],
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      // Bun's test runner is Jest-compatible. We define its globals here.
      globals: {
        'describe': 'readonly',
        'test': 'readonly',
        'expect': 'readonly',
        'beforeAll': 'readonly',
        'afterAll': 'readonly',
        'beforeEach': 'readonly',
        'afterEach': 'readonly',
        'it': 'readonly',
      },
      rules: {
        // It's common to use non-null assertions in tests where we can guarantee state.
        '@typescript-eslint/no-non-null-assertion': 'off',
      }
    }
  ],
  ignorePatterns: ['.eslintrc.cjs', 'node_modules', 'dist'],
};
````

## File: providers/whatsmeow/docker-compose.yml
````yaml
version: '3.9'

services:
  whatsmeow:
    # Image priority: Pull from Docker Hub first, build locally as fallback
    image: jelipro/whatsapp-gateway-whatsmeow:${VERSION:-latest}
    # Build configuration (used when image pull fails or --build flag is used)
    build:
      context: .
      dockerfile: Dockerfile
      args:
        VERSION: ${VERSION:-dev}
        BUILD_TIME: ${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
    container_name: ${COMPOSE_PROJECT_NAME:-whatsmeow}-hub-instance
    restart: unless-stopped

    # Resource limits for cost control and fair usage
    deploy:
      resources:
        limits:
          cpus: ${CPU_LIMIT:-0.5}
          memory: ${MEMORY_LIMIT:-512M}
        reservations:
          cpus: ${CPU_RESERVATION:-0.1}
          memory: ${MEMORY_RESERVATION:-128M}

    # Port mapping for API access
    ports:
      - "${PORT:-8080}:8080"

    # Environment variables
    environment:
      - PORT=8080
      - WEBHOOK_URL=${WEBHOOK_URL:-}
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
      - GOMAXPROCS=1

    # Volume for session persistence
    volumes:
      - whatsmeow-session:/app/session

    # Health check configuration
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s

    # Security settings
    security_opt:
      - no-new-privileges:true

    # Network configuration
    networks:
      - whatsmeow-network

    # Logging configuration
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

    # Labels for orchestration and monitoring
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.whatsmeow.rule=Host(`${DOMAIN:-localhost}`)"
      - "traefik.http.services.whatsmeow.loadbalancer.server.port=8080"
      - "com.docker.compose.project=${COMPOSE_PROJECT_NAME:-whatsmeow}"
      - "version=${VERSION:-dev}"

# Named volumes for data persistence
volumes:
  whatsmeow-session:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: ${SESSION_VOLUME_PATH:-./data/session}

# Network configuration
networks:
  whatsmeow-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
````

## File: .env.example
````
DATABASE_URL="postgresql://user:password@localhost:5432/whatsapp_gateway"
API_SECRET="your-super-secret-api-key"
INTERNAL_API_SECRET="a-different-and-very-strong-secret-for-internal-comms"
ADMIN_API_SECRET="a-secret-for-privileged-admin-operations"
GATEWAY_URL="http://host.docker.internal:3000" # URL for provider containers to reach the gateway
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

## File: tsconfig.base.json
````json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "strict": true,
    "downlevelIteration": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "allowJs": true,
    "types": [
      "bun-types"
    ]
  }
}
````

## File: tsconfig.json
````json
{
  "files": [],
  "references": [
    { "path": "drizzle" },
    { "path": "gateway" }
  ]
}
````

## File: gateway/tests/e2e/instances.test.ts
````typescript
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { db, setup, teardown, cleanupDb, cleanupContainers, TEST_USER_API_KEY, findContainerByInstanceId } from '../helpers/setup';
import * as schema from '../../../drizzle/schema';
import { eq } from 'drizzle-orm';

describe('E2E - Instance Management API', () => {
    let serverUrl: string;
    let appInstance: any;

    beforeAll(async () => {
        const setupResult = await setup();
        serverUrl = setupResult.serverUrl;
        appInstance = setupResult.app;
    });

    afterAll(async () => {
        // Final cleanup after all tests in this file run
        await cleanupContainers();
        if (appInstance) {
            await teardown(appInstance);
        }
    });

    afterEach(async () => {
        // Clean up resources between tests to ensure isolation
        await cleanupContainers();
        await cleanupDb();
    });

    test('should create, start, and delete a whatsmeow instance', async () => {
        // 1. Create Instance
        const createResponse = await fetch(`${serverUrl}/api/instances`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_USER_API_KEY}`
            },
            body: JSON.stringify({
                name: "e2e-test-instance",
                phone: "1234567890",
                provider: "whatsmeow",
            }),
        });
        
        expect(createResponse.status).toBe(200);
        const instance = await createResponse.json() as { id: number; status: string; };
        
        expect(instance.id).toBeTypeOf('number');
        expect(instance.status).toBe('running');
        const instanceId = instance.id;

        // 2. Verify instance exists in the database
        const dbInstance = await db.query.instances.findFirst({
            where: eq(schema.instances.id, instanceId),
        });
        expect(dbInstance).toBeDefined();
        expect(dbInstance?.id).toBe(instanceId);

        // 3. Verify the corresponding Docker container is running
        const container = await findContainerByInstanceId(instanceId);
        expect(container).toBeDefined();
        expect(container?.State).toBe('running');
        
        // 4. Delete the Instance
        const deleteResponse = await fetch(`${serverUrl}/api/instances/${instanceId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${TEST_USER_API_KEY}` }
        });

        expect(deleteResponse.status).toBe(204);

        // 5. Verify the container has been removed
        const containerAfterDelete = await findContainerByInstanceId(instanceId);
        expect(containerAfterDelete).toBeUndefined();

        // 6. Verify the instance has been removed from the database
        const dbInstanceAfterDelete = await db.query.instances.findFirst({
            where: eq(schema.instances.id, instanceId),
        });
        expect(dbInstanceAfterDelete).toBeUndefined();
    }, 20000); // Increase timeout to allow for docker pull/start
});
````

## File: gateway/tests/helpers/setup.ts
````typescript
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { getDockerClientForNode, type ContainerInfo } from '../../src/docker.client';
import * as schema from '../../../drizzle/schema';
import { createApp } from '../../src/app';
import { ensureTestEnvironment, getEnvironment, cleanup as testCleanup } from '../utils/test-setup';

// --- Types ---
export type User = typeof schema.users.$inferSelect;
export type Node = typeof schema.nodes.$inferSelect;
export type Instance = typeof schema.instances.$inferSelect;

// --- DB Connection ---
// These are initialized in setup() to prevent connection attempts before the test DB is ready.
let client: Sql;
export let db: PostgresJsDatabase<typeof schema>;

// --- Test Constants (initialized in setup) ---
export let TEST_USER_API_KEY: string;
export let TEST_INTERNAL_API_SECRET: string;
export let TEST_ADMIN_API_SECRET: string;
export const TEST_NODE_DOCKER_HOST = process.env.TEST_DOCKER_HOST || 'unix:///var/run/docker.sock';
export const TEST_NODE_PUBLIC_HOST_PREFIX = 'test-node.local';

const docker = getDockerClientForNode({ dockerHost: TEST_NODE_DOCKER_HOST });

interface SetupOptions {
  nodeCount?: number;
}


/**
 * Sets up the test environment:
 * 1. Establishes DB connection.
 * 2. Starts the API server on a random available port.
 * 3. Cleans and seeds the database with a test user and a test node.
 * @returns An object with the server URL and the created user/node entities.
 */
export const setup = async (options: SetupOptions = {}) => {
  const { nodeCount = 1 } = options;
  // Ensure the environment is ready. This is idempotent and safe to call.
  await ensureTestEnvironment();

  const env = getEnvironment(); // This will now succeed.
  TEST_USER_API_KEY = env.API_SECRET;
  TEST_INTERNAL_API_SECRET = env.INTERNAL_API_SECRET;
  TEST_ADMIN_API_SECRET = env.ADMIN_API_SECRET;

  // 1. Establish DB connection
  // Use the connection string from the now-initialized environment
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Please create a .env.test file.");
  }
  client = postgres(connectionString);
  db = drizzle(client, { schema });

  // 2. Create app with database and start server on a random available port
  const app = createApp(db);
  await app.listen(0);

  // 3. Clean database before seeding to ensure a fresh state.
  await db.delete(schema.instanceState);
  await db.delete(schema.instances);
  await db.delete(schema.users);
  await db.delete(schema.nodes);

  const [testUser] = await db.insert(schema.users).values({
    email: `test-${Date.now()}@example.com`,
    apiKey: TEST_USER_API_KEY,
  }).returning();

  const testNodes: Node[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const [testNode] = await db.insert(schema.nodes).values({
      name: `test-node-${i + 1}`,
      dockerHost: TEST_NODE_DOCKER_HOST,
      publicHost: `${TEST_NODE_PUBLIC_HOST_PREFIX}-${i + 1}`,
    }).returning();
    testNodes.push(testNode);
  }

  return {
    serverUrl: `http://localhost:${app.server?.port}`,
    user: testUser,
    nodes: testNodes,
    app, // Return app instance for teardown
  };
};

/**
 * Tears down the test environment:
 * 1. Stops the API server.
 * 2. Closes the database connection.
 * 3. Cleans up test database and environment.
 */
export const teardown = async (app: any) => {
  await app.stop();
  if (client) {
    await client.end({ timeout: 5 });
  }
  // Clean up the test environment (but not the database container)
  await testCleanup();
};

/**
 * Removes all instance-related records from the database.
 */
export const cleanupDb = async () => {
    // db is guaranteed to be initialized by setup() in beforeAll
    await db.delete(schema.instanceState);
    await db.delete(schema.instances);
};

/**
 * Helper to create a test instance in the database.
 */
export async function createTestInstance(
    db: PostgresJsDatabase<typeof schema>,
    user: User,
    node: Node,
    overrides: Partial<Omit<Instance, 'id' | 'userId' | 'nodeId'>> = {}
): Promise<Instance> {
    const [instance] = await db.insert(schema.instances).values({
        nodeId: node.id,
        userId: user.id,
        phoneNumber: '9876543210',
        provider: 'whatsmeow',
        status: 'running', // Default to running for most API tests
        ...overrides,
    }).returning();
    return instance;
}

/**
 * Finds and removes all Docker containers created by the tests.
 */
export const cleanupContainers = async () => {
    const containers = await docker.listContainers({
        all: true,
        filters: { label: [`whatsapp-gateway-saas.instance-id`] }
    });

    for (const containerInfo of containers) {
        console.log(`Cleaning up test container: ${containerInfo.Id}`);
        try {
            await docker.stopContainer(containerInfo.Id, { t: 5 });
        } catch (e: any) {
            // Ignore if already stopped (304) or not found (404)
            if (e.statusCode !== 304 && e.statusCode !== 404) console.error(e);
        }
        try {
            await docker.removeContainer(containerInfo.Id);
        } catch (e: any) {
             // Ignore if not found (404)
            if (e.statusCode !== 404) console.error(e);
        }
    }
};

/**
 * Test helper to find a container by its instance ID label.
 * @param instanceId The ID of the instance.
 * @returns ContainerInfo if found, otherwise undefined.
 */
export async function findContainerByInstanceId(instanceId: number): Promise<ContainerInfo | undefined> {
    const containers = await docker.listContainers({
        all: true,
        filters: { label: [`whatsapp-gateway-saas.instance-id=${instanceId}`] }
    });
    return containers[0];
}
````

## File: providers/whatsmeow/go.mod
````
module github.com/your-org/whatsapp-gateway-saas/providers/whatsmeow

go 1.23

require (
	github.com/mattn/go-sqlite3 v1.14.22
	github.com/skip2/go-qrcode v0.0.0-20200617195104-da1b6568686e
	go.mau.fi/whatsmeow v0.0.0-20251116104239-3aca43070cd4
	google.golang.org/protobuf v1.35.2
)
````

## File: gateway/tsconfig.json
````json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": true,
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true
  },
  "include": [
    "src",
    "tests"
  ],
  "references": [
    { "path": "../drizzle" }
  ]
}
````

## File: providers/whatsmeow/Dockerfile
````
# Multi-stage build for optimal image size and security
# Build stage - compiles the Go binary
FROM golang:1.24-alpine AS builder

# Install build dependencies for CGO (required for SQLite3)
RUN apk add --no-cache git ca-certificates tzdata gcc musl-dev

# Set working directory
WORKDIR /src

# Copy go mod file first for better layer caching
COPY go.mod ./

# Download dependencies - this layer only rebuilds when go.mod changes
RUN go mod download

# Copy source code
COPY . .

# Generate go.sum and tidy dependencies
RUN go mod tidy

# Build arguments for versioning and optimization
ARG VERSION=dev
ARG BUILD_TIME

# Build the application with optimizations
# - CGO_ENABLED=1 required for SQLite3 support
# - -ldflags strips debug symbols and sets build info
# - -trimpath removes file system paths from binary
RUN CGO_ENABLED=1 \
    GOOS=linux \
    GOARCH=amd64 \
    go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION} -X main.buildTime=${BUILD_TIME}" \
    -o /bin/whatsapp-gateway \
    .

# Final runtime stage - minimal secure image
FROM alpine:3.20

# Install runtime dependencies
RUN apk --no-cache add \
    ca-certificates \
    tzdata \
    wget \
    sqlite \
    && rm -rf /var/cache/apk/*

# Create non-root user and group for security
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G appgroup appuser

# Create directories with proper permissions
RUN mkdir -p /app/session /app/logs && \
    chown -R appuser:appgroup /app && \
    chmod 755 /app/session

# Set working directory
WORKDIR /app

# Copy binary from builder stage
COPY --from=builder /bin/whatsapp-gateway /usr/local/bin/whatsapp-gateway

# Ensure binary is executable
RUN chmod +x /usr/local/bin/whatsapp-gateway

# Switch to non-root user
USER appuser

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expose application port
EXPOSE 8080

# Define persistent volumes
VOLUME ["/app/session"]

# Set environment variables
ENV PORT=8080
ENV GOMAXPROCS=1

# Container entrypoint
ENTRYPOINT ["whatsapp-gateway"]
````

## File: providers/whatsmeow/main.go
````go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var client *whatsmeow.Client
var waLogger waLog.Logger
var qrCodeStr string
var qrCodeMutex sync.RWMutex
var startTime = time.Now()

// --- State Snapshotting ---
var (
	gatewayURL      = os.Getenv("GATEWAY_URL")
	instanceID      = os.Getenv("INSTANCE_ID")
	internalAPISecret = os.Getenv("INTERNAL_API_SECRET")
	dbPath          = "/app/session/whatsmeow.db"
)

func fetchStateSnapshot() error {
	if gatewayURL == "" || instanceID == "" || internalAPISecret == "" {
		waLogger.Warnf("State snapshotting disabled: missing GATEWAY_URL, INSTANCE_ID, or INTERNAL_API_SECRET")
		return nil
	}
	url := fmt.Sprintf("%s/internal/state/%s/snapshot", gatewayURL, instanceID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create snapshot fetch request: %w", err)
	}
	req.Header.Set("X-Internal-Secret", internalAPISecret)

	waLogger.Infof("Fetching state snapshot from %s", url)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute snapshot fetch request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		waLogger.Infof("No existing state snapshot found. Starting fresh.")
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to fetch snapshot, status: %s", resp.Status)
	}

	// Ensure session directory exists
	if err := os.MkdirAll("/app/session", 0755); err != nil {
		return fmt.Errorf("failed to create session directory: %w", err)
	}

	file, err := os.Create(dbPath)
	if err != nil {
		return fmt.Errorf("failed to create database file: %w", err)
	}
	defer file.Close()

	_, err = io.Copy(file, resp.Body)
	if err != nil {
		return fmt.Errorf("failed to write snapshot to file: %w", err)
	}
	waLogger.Infof("Successfully restored state snapshot.")
	return nil
}

func uploadStateSnapshot() {
	if gatewayURL == "" || instanceID == "" || internalAPISecret == "" {
		waLogger.Warnf("State snapshotting disabled: missing GATEWAY_URL, INSTANCE_ID, or INTERNAL_API_SECRET")
		return
	}

	fileData, err := os.ReadFile(dbPath)
	if err != nil {
		if os.IsNotExist(err) {
			waLogger.Warnf("Database file not found at %s, nothing to snapshot.", dbPath)
			return
		}
		waLogger.Errorf("Failed to read database file for snapshotting: %v", err)
		return
	}

	url := fmt.Sprintf("%s/internal/state/%s/snapshot", gatewayURL, instanceID)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(fileData))
	if err != nil {
		waLogger.Errorf("Failed to create snapshot upload request: %v", err)
		return
	}
	req.Header.Set("X-Internal-Secret", internalAPISecret)
	req.Header.Set("Content-Type", "application/octet-stream")

	waLogger.Infof("Uploading state snapshot to %s", url)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		waLogger.Errorf("Failed to execute snapshot upload request: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		waLogger.Errorf("Failed to upload snapshot, status: %s", resp.Status)
	} else {
		waLogger.Infof("Successfully uploaded state snapshot.")
	}
}

// --- End State Snapshotting ---

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
		waLogger.Infof("Received message from %s: %s", v.Info.Sender, v.Message.GetConversation())
		payload = webhookPayload{Event: "message", Data: v}
	case *events.Connected:
		waLogger.Infof("Connected to WhatsApp")
		payload = webhookPayload{Event: "connected", Data: nil}
	case *events.Disconnected:
		waLogger.Infof("Disconnected from WhatsApp")
		payload = webhookPayload{Event: "disconnected", Data: nil}
	default:
		return // Ignore other events for now
	}

	go sendWebhook(webhookURL, payload)
}

func sendWebhook(url string, payload webhookPayload) {
	data, err := json.Marshal(payload)
	if err != nil {
		waLogger.Errorf("Failed to marshal webhook payload: %v", err)
		return
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(data))
	if err != nil {
		waLogger.Errorf("Failed to create webhook request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		waLogger.Errorf("Failed to send webhook: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		waLogger.Warnf("Webhook call failed with status: %s", resp.Status)
	}
}

func getQR(w http.ResponseWriter, r *http.Request) {
	qrCodeMutex.RLock()
	defer qrCodeMutex.RUnlock()
	if qrCodeStr == "" {
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"status": "no_qr", "message": "QR code not available"}`, http.StatusNotFound)
		return
	}
	// Return QR code as PNG image for better compatibility
	w.Header().Set("Content-Type", "image/png")
	png, err := qrcode.Encode(qrCodeStr, qrcode.Medium, 256)
	if err != nil {
		http.Error(w, "Failed to generate QR code", http.StatusInternalServerError)
		return
	}
	w.Write(png)
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
		waLogger.Errorf("Invalid JID %s: %v", arg, err)
		return recipient, false
	} else if recipient.User == "" {
		waLogger.Errorf("Invalid JID %s: no user specified", arg)
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

	msg := &waE2E.Message{
		Conversation: proto.String(reqBody.Text),
	}

	ts, err := client.SendMessage(context.Background(), recipient, msg)
	if err != nil {
		waLogger.Errorf("Error sending message: %v", err)
		http.Error(w, "Failed to send message", http.StatusInternalServerError)
		return
	}

	waLogger.Infof("Message sent to %s (ID: %s, Timestamp: %s)", recipient.String(), ts.ID, ts.Timestamp)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "id": ts.ID})
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	connected := client != nil && client.IsConnected()
	phoneID := ""
	if client != nil && client.Store.ID != nil {
		phoneID = client.Store.ID.String()
	}

	response := map[string]interface{}{
		"status":      "healthy",
		"connected":   connected,
		"phone_id":    phoneID,
		"uptime":      time.Since(startTime).String(),
		"version":     "1.0.0",
		"timestamp":   time.Now().Unix(),
	}

	json.NewEncoder(w).Encode(response)
}

func startAPIServer() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/status", healthHandler) // Alias for health
	http.HandleFunc("/qr", getQR)
	http.HandleFunc("/send", sendText)
	waLogger.Infof("Starting internal API server on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatalf("API server failed: %v", err)
	}
}

func main() {
	waLogger = waLog.Stdout("main", "INFO", true)
	dbLog := waLog.Stdout("Database", "INFO", true)

	// Fetch state from gateway before initializing DB connection
	if err := fetchStateSnapshot(); err != nil {
		// We panic here because a failed restore could lead to data loss
		// or an inconsistent state. It's safer to fail hard.
		panic(fmt.Errorf("critical error during state restoration: %w", err))
	}

	ctx := context.Background()
	container, err := sqlstore.New(ctx, "sqlite3", fmt.Sprintf("file:%s?_foreign_keys=on", dbPath), dbLog)
	if err != nil {
		panic(err)
	}
	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		panic(err)
	}

	client = whatsmeow.NewClient(deviceStore, waLogger)
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
				waLogger.Infof("Login event: %s", evt.Event)
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

	waLogger.Infof("Received shutdown signal. Uploading state snapshot...")
	uploadStateSnapshot()
	client.Disconnect()
	waLogger.Infof("Disconnected. Goodbye.")
}
````

## File: drizzle/schema.ts
````typescript
import { pgTable, serial, text, varchar, timestamp, integer, uniqueIndex, pgEnum, unique, customType } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const nodes = pgTable('nodes', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 256 }).notNull().unique(),
  dockerHost: text('docker_host').notNull(), // e.g., 'tcp://1.2.3.4:2375'
  publicHost: text('public_host').notNull(), // e.g., 'vps1.example.com'
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 256 }).notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const providerEnum = pgEnum('provider', ['whatsmeow', 'baileys', 'wawebjs', 'waba']);
export const instanceStatusEnum = pgEnum('status', ['creating', 'starting', 'running', 'stopped', 'error', 'migrating']);

export const instances = pgTable('instances', {
    id: serial('id').primaryKey(),
    nodeId: integer('node_id').notNull().references(() => nodes.id, { onDelete: 'restrict' }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 256 }),
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

const bytea = customType<{ data: Buffer }>({
    dataType() {
        return 'bytea';
    },
});

export const instanceState = pgTable('instance_state', {
    id: serial('id').primaryKey(),
    instanceId: integer('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: bytea('value').notNull(),
}, (table) => {
    return {
        instanceKeyIdx: unique('instance_key_idx').on(table.instanceId, table.key),
    };
});

export const userRelations = relations(users, ({ many }) => ({
  instances: many(instances),
}));

export const instanceRelations = relations(instances, ({ one, many }) => ({
  user: one(users, {
    fields: [instances.userId],
    references: [users.id],
  }),
  node: one(nodes, {
    fields: [instances.nodeId],
    references: [nodes.id],
  }),
  state: many(instanceState),
}));

export const instanceStateRelations = relations(instanceState, ({ one }) => ({
    instance: one(instances, {
        fields: [instanceState.instanceId],
        references: [instances.id],
    }),
}));

export const nodeRelations = relations(nodes, ({ many }) => ({
    instances: many(instances),
}));
````

## File: package.json
````json
{
  "name": "whatsapp-gateway-saas",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "gateway",
    "drizzle"
  ],
  "scripts": {
    "dev": "bun --cwd gateway run dev",
    "test": "bun --cwd gateway run test",
    "test:watch": "bun --cwd gateway run test --watch",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "devDependencies": {
    "drizzle-kit": "latest",
    "dotenv": "latest",
    "dotenv-cli": "latest",
    "typescript": "latest"
  }
}
````

## File: gateway/package.json
````json
{
  "name": "gateway",
  "module": "src/index.ts",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "lint": "eslint .",
    "typecheck": "tsc -b",
    "test": "bun test"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "latest",
    "@typescript-eslint/parser": "latest",
    "bun-types": "latest",
    "eslint": "latest",
    "typescript": "latest"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "elysia": "latest",
    "drizzle-orm": "latest",
    "postgres": "latest"
  },
  "testOptions": {
    "setup": "./tests/setup.ts"
  }
}
````

## File: gateway/src/docker.service.ts
````typescript
import { getDockerClientForNode, type ContainerInfo } from './docker.client';

// A simple representation of a worker node, passed from the API layer.
export interface WorkerNode {
    id: number;
    dockerHost: string;
    publicHost: string;
}

function getImageForProvider(provider: string): string {
    const imageMap: Record<string, string> = {
        'whatsmeow': 'jelipro/whatsapp-gateway-whatsmeow:latest',
        // 'baileys': 'some-other-image:latest',
    };
    const image = imageMap[provider];
    if (!image) {
        throw new Error(`Unsupported provider: ${provider}`);
    }
    return image;
}

interface CreateContainerOptions {
    instanceId: number;
    node: WorkerNode;
    name?: string | null;
    webhookUrl: string;
    cpuLimit: string;
    memoryLimit: string;
    provider: string;
}

export function sanitizeForContainerName(name: string): string {
    if (!name) return '';
    return name.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-');
}

export async function createAndStartContainer(options: CreateContainerOptions) {
    const docker = getDockerClientForNode(options.node);
    const saneName = sanitizeForContainerName(options.name || '');
    const containerName = options.name 
        ? `wgs-${options.instanceId}-${saneName}`
        : `wgs-instance-${options.instanceId}`;

    const routerName = `wgs-instance-${options.instanceId}`;

    console.log(`Creating container ${containerName} for instance ${options.instanceId} on node ${options.node.publicHost}`);

    const DOCKER_IMAGE = getImageForProvider(options.provider);

    // 1. Pull the image on the target node
    await pullImage(DOCKER_IMAGE, options.node);

    const gatewayUrl = process.env.GATEWAY_URL; // Should be reachable from worker nodes
    const internalApiSecret = process.env.INTERNAL_API_SECRET;

    // 2. Create the container
    const createResponse = await docker.createContainer({
        Image: DOCKER_IMAGE,
        name: containerName,
        Env: [
            `INSTANCE_ID=${options.instanceId}`,
            `GATEWAY_URL=${gatewayUrl}`,
            `INTERNAL_API_SECRET=${internalApiSecret}`,
            `WEBHOOK_URL=${options.webhookUrl}`,
            `PORT=8080`,
            `GOMAXPROCS=1`
        ],
        Labels: {
            'whatsapp-gateway-saas.instance-id': String(options.instanceId),
            // Traefik Labels for reverse proxying
            'traefik.enable': 'true',
            [`traefik.http.routers.${routerName}.rule`]: `Host(\`${options.node.publicHost}\`) && PathPrefix(\`/instances/${options.instanceId}\`)`,
            [`traefik.http.routers.${routerName}.entrypoints`]: 'websecure',
            [`traefik.http.routers.${routerName}.tls.certresolver`]: 'myresolver',
            [`traefik.http.services.${routerName}.loadbalancer.server.port`]: '8080',
            // Middleware to strip the prefix, so /instances/123/qr becomes /qr for the container
            [`traefik.http.middlewares.${routerName}-stripprefix.stripprefix.prefixes`]: `/instances/${options.instanceId}`,
            [`traefik.http.routers.${routerName}.middlewares`]: `${routerName}-stripprefix`,
        },
        HostConfig: {
            RestartPolicy: { Name: 'unless-stopped' },
            Memory: parseMemory(options.memoryLimit),
            NanoCpus: parseFloat(options.cpuLimit || '0') * 1e9,
            NetworkMode: process.env.NODE_ENV === 'test' ? 'bridge' : 'worker-net', // Use bridge network for tests
        },
    });

    // 3. Start the container
    await docker.startContainer(createResponse.Id);
    console.log(`Container started with ID: ${createResponse.Id}`);

    return docker.inspectContainer(createResponse.Id);
}

export async function stopAndRemoveContainer(instanceId: number, node: WorkerNode) {
    const docker = getDockerClientForNode(node);
    try {
        const container = await findContainer(instanceId, node);
        if (!container) {
            console.log(`Container for instance ${instanceId} on node ${node.dockerHost} not found, nothing to do.`);
            return;
        }

        console.log(`Stopping and removing container ${container.Id} for instance ${instanceId}`);
        
        // Stop with a 10-second timeout to allow graceful shutdown
        await docker.stopContainer(container.Id, { t: 10 }).catch(err => {
            // Ignore "container already stopped" or "no such container" errors
            if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
        });

        await docker.removeContainer(container.Id).catch(err => {
             // Ignore "no such container" errors
            if (err.statusCode !== 404) throw err;
        });
        console.log(`Container for instance ${instanceId} removed successfully.`);
    } catch (error: any) {
        if (error.statusCode === 404) {
             console.log(`Container for instance ${instanceId} on node ${node.dockerHost} not found, nothing to do.`);
             return;
        }
        console.error(`Error stopping/removing container for instance ${instanceId} on node ${node.dockerHost}:`, error);
        throw error;
    }
}

export async function findContainer(instanceId: number, node: WorkerNode): Promise<ContainerInfo | null> {
    const docker = getDockerClientForNode(node);
    try {
        const containers = await docker.listContainers({
            all: true,
            filters: {
                label: [`whatsapp-gateway-saas.instance-id=${instanceId}`]
            }
        });

        if (containers.length === 0) {
            return null;
        }
        if (containers.length > 1) {
            console.warn(`Found multiple containers for instance ${instanceId} on node ${node.dockerHost}. Using the first one.`);
        }
        return containers[0];
    } catch (error) {
        console.error(`Error finding container for instance ${instanceId} on node ${node.dockerHost}:`, error);
        return null;
    }
}

async function pullImage(imageName: string, node: WorkerNode): Promise<void> {
    const docker = getDockerClientForNode(node);
    console.log(`Ensuring image ${imageName} is available on node ${node.dockerHost}...`);
    try {
        const images = await docker.listImages({ filters: { reference: [imageName] } });
        if (images.length > 0) {
            console.log(`Image ${imageName} already exists on node.`);
            return;
        }

        console.log(`Pulling image ${imageName} on node ${node.dockerHost}...`);
        // The pull response is a stream of progress events. We just need to wait for it to finish.
        const pullResponse = await docker.pullImage(imageName);
        // Consuming the body ensures we wait for the pull to complete.
        await pullResponse.text();

        console.log(`Image ${imageName} pulled successfully on node.`);
    } catch (error) {
        console.error(`Failed to pull image ${imageName} on node ${node.dockerHost}:`, error);
        throw error;
    }
}

export function parseMemory(memoryStr: string): number {
    if (!memoryStr) return 0; // default
    const unit = memoryStr.slice(-1).toLowerCase();
    const value = parseFloat(memoryStr.slice(0, -1));

    if (isNaN(value)) return 0;

    switch (unit) {
        case 'g': return value * 1024 * 1024 * 1024;
        case 'm': return value * 1024 * 1024;
        case 'k': return value * 1024;
        default: return parseFloat(memoryStr); // Assume bytes if no unit
    }
}
````

## File: gateway/src/index.ts
````typescript
import { createApp } from './app';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../drizzle/schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString);
const db = drizzle(client, { schema });

// Create the app with the database connection
const app = createApp(db);

// Start the server only if this file is the main module
if (import.meta.main) {
    app.listen(3000);
    console.log(
      `🦊 Gateway is running at ${app.server?.hostname}:${app.server?.port}`
    );
}
````
