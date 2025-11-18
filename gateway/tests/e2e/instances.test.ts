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