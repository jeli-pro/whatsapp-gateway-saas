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

  // Update GATEWAY_URL to match the actual port the gateway is running on
  // Use 172.17.0.1 (Docker bridge gateway) for containers to reach the host on Linux
  const actualPort = app.server?.port;
  if (actualPort) {
    process.env.GATEWAY_URL = `http://172.17.0.1:${actualPort}`;
  }

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
      // In tests, the gateway connects to localhost with a mapped port.
      // In production, this would be the actual public domain/IP.
      publicHost: `localhost`,
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