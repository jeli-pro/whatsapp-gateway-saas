// Simple Docker service using Bun.shell for compatibility

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

interface DockerContainer {
    Id: string;
    Name: string;
    State: {
        Running: boolean;
        Status: string;
    };
    NetworkSettings: {
        IPAddress: string;
    };
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

    // Pull the image first
    await pullImage(DOCKER_IMAGE);

    const gatewayUrl = process.env.GATEWAY_URL || 'http://host.docker.internal:3000';
    const internalApiSecret = process.env.INTERNAL_API_SECRET;

    // Create and start container using docker CLI
    const dockerCmd = `docker run -d \
        --name ${containerName} \
        --restart unless-stopped \
        --cpus="${options.cpuLimit}" \
        --memory="${options.memoryLimit}" \
        -e INSTANCE_ID="${options.instanceId}" \
        -e GATEWAY_URL="${gatewayUrl}" \
        -e INTERNAL_API_SECRET="${internalApiSecret}" \
        -e WEBHOOK_URL="${options.webhookUrl}" \
        -l "whatsapp-gateway-saas.instance-id=${options.instanceId}" \
        ${DOCKER_IMAGE}`;

    console.log(`Running: ${dockerCmd}`);
    const dockerProcess = Bun.spawn(["sh", "-c", dockerCmd]);
    const result = await new Response(dockerProcess.stdout).text();

    // Wait for process to complete and check exit code
    await dockerProcess.exited;
    if (dockerProcess.exitCode !== 0) {
        const stderr = await new Response(dockerProcess.stderr).text();
        throw new Error(`Failed to create container: ${stderr}`);
    }

    const containerId = result.trim();
    console.log(`Container started with ID: ${containerId}`);

    return { Id: containerId };
}

export async function stopAndRemoveContainer(instanceId: number) {
    const containerName = `instance-${instanceId}`;
    try {
        // Check if container exists
        const container = await findContainer(instanceId);
        if (!container) {
            console.log(`Container ${containerName} not found, nothing to do.`);
            return true;
        }

        const containerId = container.Id;

        // Stop and remove container
        console.log(`Stopping and removing container ${containerName}`);
        const stopProcess = Bun.spawn(["sh", "-c", `docker stop ${containerName}`]);
        await stopProcess.exited;

        const rmProcess = Bun.spawn(["sh", "-c", `docker rm ${containerName}`]);
        await rmProcess.exited;

        return true;
    } catch (error: any) {
        if (error.message.includes('No such container')) {
            console.log(`Container ${containerName} not found, nothing to do.`);
            return true;
        }
        console.error(`Error stopping/removing container ${containerName}:`, error);
        throw error;
    }
}

export async function findContainer(instanceId: number): Promise<DockerContainer | null> {
    try {
        const containerName = `instance-${instanceId}`;

        // Get container info using docker inspect
        const inspectProcess = Bun.spawn(["sh", "-c", `docker inspect ${containerName} 2>/dev/null || true`]);
        const output = await new Response(inspectProcess.stdout).text();
        await inspectProcess.exited;

        if (!output || output.trim() === '[]') {
            return null;
        }

        const inspectData = JSON.parse(output)[0];
        return {
            Id: inspectData.Id,
            Name: inspectData.Name,
            State: {
                Running: inspectData.State.Running,
                Status: inspectData.State.Status,
            },
            NetworkSettings: {
                IPAddress: inspectData.NetworkSettings.IPAddress,
            }
        };
    } catch (error) {
        return null;
    }
}

async function pullImage(imageName: string): Promise<void> {
    console.log(`Pulling image ${imageName}...`);
    try {
        const pullProcess = Bun.spawn(["sh", "-c", `docker pull ${imageName}`]);
        const output = await new Response(pullProcess.stdout).text();
        await pullProcess.exited;

        if (pullProcess.exitCode !== 0) {
            const stderr = await new Response(pullProcess.stderr).text();
            throw new Error(`Failed to pull image: ${stderr}`);
        }
        console.log(`Image ${imageName} pulled successfully.`);
    } catch (error) {
        console.error(`Failed to pull image ${imageName}:`, error);
        throw error;
    }
}