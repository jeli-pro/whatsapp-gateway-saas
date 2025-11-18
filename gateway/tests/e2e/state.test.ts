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