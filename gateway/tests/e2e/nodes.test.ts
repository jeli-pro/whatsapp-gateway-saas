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