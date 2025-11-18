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

          const instanceUrl = `https://${instanceData.nodes.publicHost}/instances/${instanceId}/qr`;
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

          const instanceUrl = `https://${instanceData.nodes.publicHost}/instances/${instanceId}/send`;

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
    );
}