import Docker from 'dockerode';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
 
function getImageForProvider(provider: string): string {
    // In a real scenario, this could come from a config file or database
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
    webhookUrl: string;
    cpuLimit: string;
    memoryLimit: string;
    provider: string;
}

export async function createAndStartContainer(options: CreateContainerOptions) {
    const containerName = `instance-${options.instanceId}`;
    console.log(`Creating container ${containerName}`);

    const DOCKER_IMAGE = getImageForProvider(options.provider);
    // First, try to pull the image to ensure it's up to date
    await pullImage(DOCKER_IMAGE);

    const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:3000';
    const internalApiSecret = process.env.INTERNAL_API_SECRET;

    const container = await docker.createContainer({
        Image: DOCKER_IMAGE,
        name: containerName,
        Env: [
            `INSTANCE_ID=${options.instanceId}`,
            `GATEWAY_URL=${gatewayUrl}`,
            `INTERNAL_API_SECRET=${internalApiSecret}`,
            `WEBHOOK_URL=${options.webhookUrl}`
        ],
        HostConfig: {
            // Restart unless manually stopped
            RestartPolicy: {
                Name: 'unless-stopped',
            },
            // Resource limits
            NanoCpus: Math.floor(parseFloat(options.cpuLimit) * 1e9), // e.g. 0.5 -> 500000000
            Memory: parseMemory(options.memoryLimit), // e.g. "512m" -> 536870912
        },
        Labels: {
            'whatsapp-gateway-saas.instance-id': String(options.instanceId),
        }
    });

    console.log(`Starting container ${container.id}`);
    await container.start();

    return container;
}

export async function stopAndRemoveContainer(instanceId: number) {
    const containerName = `instance-${instanceId}`;
    try {
        const container = docker.getContainer(containerName);
        const inspect = await container.inspect();
        if (inspect.State.Running) {
            console.log(`Stopping container ${containerName}`);
            await container.stop();
        }
        console.log(`Removing container ${containerName}`);
        await container.remove();
        return true;
    } catch (error: any) {
        if (error.statusCode === 404) {
            console.log(`Container ${containerName} not found, nothing to do.`);
            return true;
        }
        console.error(`Error stopping/removing container ${containerName}:`, error);
        throw error;
    }
}

export async function findContainer(instanceId: number) {
    try {
        const container = docker.getContainer(`instance-${instanceId}`);
        return await container.inspect();
    } catch (error: any) {
        if (error.statusCode === 404) {
            return null;
        }
        throw error;
    }
}

function pullImage(imageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        console.log(`Pulling image ${imageName}...`);
        docker.pull(imageName, (err: Error, stream: NodeJS.ReadableStream) => {
            if (err) {
                return reject(err);
            }
            docker.modem.followProgress(stream, onFinished, onProgress);

            function onFinished(err: Error | null, output: any) {
                if (err) {
                    return reject(err);
                }
                console.log(`Image ${imageName} pulled successfully.`);
                resolve();
            }
            function onProgress(event: any) {
                // You can add progress reporting here if needed
            }
        });
    });
}

function parseMemory(mem: string): number {
    const unit = mem.charAt(mem.length - 1).toLowerCase();
    const value = parseInt(mem.slice(0, -1), 10);
    switch (unit) {
        case 'g': return value * 1024 * 1024 * 1024;
        case 'm': return value * 1024 * 1024;
        case 'k': return value * 1024;
        default: return parseInt(mem, 10);
    }
}