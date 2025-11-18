import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { getDockerClientForNode, type ContainerInfo } from '../../src/docker.client';
import * as schema from '../../../drizzle/schema';
import { app } from '../../src/index';

// --- Types ---
export type User = typeof schema.users.$inferSelect;
export type Node = typeof schema.nodes.$inferSelect;
export type Instance = typeof schema.instances.$inferSelect;

// --- DB Connection ---
// These are initialized in setup() to prevent connection attempts before the test DB is ready.
let client: Sql;
export let db: PostgresJsDatabase<typeof schema>;

// --- Docker Client ---
// --- Test Constants ---
// Bun automatically loads .env, but we provide fallbacks.
export const TEST_USER_API_KEY = process.env.API_SECRET || 'test-api-key-secret-for-ci';
export const TEST_INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'test-internal-secret-for-ci';
export const TEST_NODE_DOCKER_HOST = process.env.TEST_DOCKER_HOST || 'unix:///var/run/docker.sock';
export const TEST_NODE_PUBLIC_HOST = 'localhost';

const docker = getDockerClientForNode({ dockerHost: TEST_NODE_DOCKER_HOST });


/**
 * Sets up the test environment:
 * 1. Establishes DB connection.
 * 2. Starts the API server on a random available port.
 * 3. Cleans and seeds the database with a test user and a test node.
 * @returns An object with the server URL and the created user/node entities.
 */
export const setup = async () => {
  // 1. Establish DB connection
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Please create a .env.test file.");
  }
  client = postgres(connectionString);
  db = drizzle(client, { schema });

  // 2. Start server on a random available port by passing 0.
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

  const [testNode] = await db.insert(schema.nodes).values({
    name: 'test-node-1',
    dockerHost: TEST_NODE_DOCKER_HOST,
    publicHost: TEST_NODE_PUBLIC_HOST,
  }).returning();

  return {
    serverUrl: `http://localhost:${app.server?.port}`,
    user: testUser,
    node: testNode,
  };
};

/**
 * Tears down the test environment:
 * 1. Stops the API server.
 * 2. Closes the database connection.
 */
export const teardown = async () => {
  await app.stop();
  if (client) {
    await client.end({ timeout: 5 });
  }
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