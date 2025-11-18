import Dockerode from 'dockerode';

export const docker = new Dockerode(); // Assumes DOCKER_HOST or default socket path is configured

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
    name?: string | null;
    webhookUrl: string;
    cpuLimit: string;
    memoryLimit: string;
    provider: string;
}

function sanitizeForContainerName(name: string): string {
    if (!name) return '';
    return name.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-');
}

export async function createAndStartContainer(options: CreateContainerOptions) {
    const saneName = sanitizeForContainerName(options.name || '');
    const containerName = options.name 
        ? `wgs-${options.instanceId}-${saneName}`
        : `wgs-instance-${options.instanceId}`;

    console.log(`Creating container ${containerName} for instance ${options.instanceId}`);

    const DOCKER_IMAGE = getImageForProvider(options.provider);

    // 1. Pull the image
    await pullImage(DOCKER_IMAGE);

    const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:3000';
    const internalApiSecret = process.env.INTERNAL_API_SECRET;

    // 2. Create the container
    const container = await docker.createContainer({
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
        },
        HostConfig: {
            RestartPolicy: { Name: 'unless-stopped' },
            Memory: parseMemory(options.memoryLimit), 
            NanoCpus: parseFloat(options.cpuLimit || '0') * 1e9,
        },
    });

    // 3. Start the container
    await container.start();
    console.log(`Container started with ID: ${container.id}`);

    return container.inspect();
}

export async function stopAndRemoveContainer(instanceId: number) {
    try {
        const container = await findContainer(instanceId);
        if (!container) {
            console.log(`Container for instance ${instanceId} not found, nothing to do.`);
            return;
        }

        console.log(`Stopping and removing container ${container.Id} for instance ${instanceId}`);
        const containerInstance = docker.getContainer(container.Id);
        
        // Stop with a 10-second timeout to allow graceful shutdown
        await containerInstance.stop({ t: 10 }).catch(err => {
            // Ignore "container already stopped" or "no such container" errors
            if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
        });

        await containerInstance.remove().catch(err => {
             // Ignore "no such container" errors
            if (err.statusCode !== 404) throw err;
        });
        console.log(`Container for instance ${instanceId} removed successfully.`);
    } catch (error: any) {
        if (error.statusCode === 404) {
             console.log(`Container for instance ${instanceId} not found, nothing to do.`);
             return;
        }
        console.error(`Error stopping/removing container for instance ${instanceId}:`, error);
        throw error;
    }
}

export async function findContainer(instanceId: number): Promise<Dockerode.ContainerInfo | null> {
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
            console.warn(`Found multiple containers for instance ${instanceId}. Using the first one.`);
        }
        return containers[0];
    } catch (error) {
        console.error(`Error finding container for instance ${instanceId}:`, error);
        return null;
    }
}

async function pullImage(imageName: string): Promise<void> {
    console.log(`Ensuring image ${imageName} is available...`);
    try {
        const images = await docker.listImages({ filters: { reference: [imageName] } });
        if (images.length > 0) {
            console.log(`Image ${imageName} already exists locally.`);
            return;
        }

        console.log(`Pulling image ${imageName}...`);
        const pullStream = await docker.pull(imageName);
        
        await new Promise<void>((resolve, reject) => {
            docker.modem.followProgress(pullStream, (err, _res) => err ? reject(err) : resolve());
        });

        console.log(`Image ${imageName} pulled successfully.`);
    } catch (error) {
        console.error(`Failed to pull image ${imageName}:`, error);
        throw error;
    }
}

function parseMemory(memoryStr: string): number {
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