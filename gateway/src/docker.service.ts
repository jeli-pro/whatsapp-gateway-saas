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
            NetworkMode: 'worker-net', // Connect to the shared traefik network
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