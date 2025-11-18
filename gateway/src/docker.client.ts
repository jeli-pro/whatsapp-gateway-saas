import { URL } from 'url';

// Simplified subset of Dockerode's ContainerInfo
export interface ContainerInfo {
    Id: string;
    Names: string[];
    Image: string;
    ImageID: string;
    Command: string;
    Created: number;
    State: string;
    Status: string;
    Ports: any[];
    Labels: Record<string, string>;
    SizeRw?: number;
    SizeRootFs?: number;
    HostConfig: {
        NetworkMode: string;
    };
    NetworkSettings: {
        Networks: any;
    };
    Mounts: any[];
}

export interface WorkerNode {
    id: number;
    dockerHost: string;
    publicHost: string;
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
    body?: any;
    headers?: Record<string, string>;
    json?: boolean;
}

class DockerClient {
    private socketPath?: string;
    private host?: string;
    private port?: number;

    constructor(node: Pick<WorkerNode, 'dockerHost'>) {
        if (node.dockerHost.startsWith('unix://') || node.dockerHost.startsWith('/')) {
            this.socketPath = node.dockerHost.replace('unix://', '');
        } else if (node.dockerHost.startsWith('tcp://')) {
            const parsedUrl = new URL(node.dockerHost);
            this.host = parsedUrl.hostname;
            this.port = parseInt(parsedUrl.port, 10);
        } else {
            const [host, port] = node.dockerHost.split(':');
            this.host = host;
            this.port = parseInt(port, 10);
        }
    }

    private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const method = options.method || 'GET';
        const headers = options.headers || {};

        let url: string;
        let fetchOptions: RequestInit = { method, headers };

        if (this.socketPath) {
            // Path must be absolute for unix socket fetch
            const absolutePath = path.startsWith('/') ? path : `/${path}`;
            url = `http://localhost${absolutePath}`;
            (fetchOptions as any).unix = this.socketPath;
        } else {
            url = `http://${this.host}:${this.port}${path}`;
        }
        
        if (options.body) {
            if (typeof options.body === 'object' && options.body !== null) {
                headers['Content-Type'] = 'application/json';
                fetchOptions.body = JSON.stringify(options.body);
            } else {
                fetchOptions.body = options.body;
            }
        }
        
        const res = await fetch(url, fetchOptions);

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`Docker API Error (${res.status} on ${method} ${path}): ${errorText}`);
            const error: any = new Error(`Docker API request failed: ${res.status} ${res.statusText}`);
            error.statusCode = res.status;
            error.reason = res.statusText;
            error.responseBody = errorText;
            throw error;
        }

        if (res.status === 204) {
            return null as T;
        }
        
        if (options.json === false) { // for streams
            return res as T;
        }

        return res.json() as Promise<T>;
    }
    
    // Equivalent of docker.listContainers
    async listContainers(options?: { all?: boolean, filters?: any }): Promise<ContainerInfo[]> {
        const params = new URLSearchParams();
        if (options?.all) {
            params.set('all', 'true');
        }
        if (options?.filters) {
            params.set('filters', JSON.stringify(options.filters));
        }
        return this.request(`/containers/json?${params.toString()}`);
    }

    // Equivalent of docker.createContainer
    async createContainer(options: any): Promise<{ Id: string, Warnings: string[] }> {
        const params = new URLSearchParams();
        if(options.name) {
            params.set('name', options.name);
        }
        return this.request(`/containers/create?${params.toString()}`, {
            method: 'POST',
            body: options,
        });
    }

    // Equivalent of container.start
    async startContainer(containerId: string): Promise<void> {
        await this.request(`/containers/${containerId}/start`, { method: 'POST' });
    }

    // Equivalent of container.stop
    async stopContainer(containerId: string, options?: { t?: number }): Promise<void> {
        const params = new URLSearchParams();
        if (options?.t) {
            params.set('t', options.t.toString());
        }
        await this.request(`/containers/${containerId}/stop?${params.toString()}`, { method: 'POST' });
    }

    // Equivalent of container.remove
    async removeContainer(containerId: string): Promise<void> {
        await this.request(`/containers/${containerId}`, { method: 'DELETE' });
    }

    // Equivalent of container.inspect
    async inspectContainer(containerId: string): Promise<any> {
        return this.request(`/containers/${containerId}/json`);
    }

    // Equivalent of docker.listImages
    async listImages(options?: { filters?: any }): Promise<any[]> {
        const params = new URLSearchParams();
        if (options?.filters) {
            params.set('filters', JSON.stringify(options.filters));
        }
        return this.request(`/images/json?${params.toString()}`);
    }

    // Equivalent of docker.pull
    async pullImage(imageName: string): Promise<Response> {
        const [image, tag] = imageName.split(':');
        const params = new URLSearchParams({ fromImage: image, tag: tag || 'latest' });
        // This returns a stream, so don't parse as JSON
        return this.request(`/images/create?${params.toString()}`, { method: 'POST', json: false });
    }
}

export function getDockerClientForNode(node: Pick<WorkerNode, 'dockerHost'>): DockerClient {
    return new DockerClient(node);
}