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