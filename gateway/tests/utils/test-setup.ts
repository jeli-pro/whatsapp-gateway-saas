import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from '../../../drizzle/schema';
import { promises as fs } from 'fs';

export interface TestEnvironment {
  DATABASE_URL: string;
  INTERNAL_API_SECRET: string;
  API_SECRET: string;
  ADMIN_API_SECRET: string;
  GATEWAY_URL: string;
  NODE_ENV: string;
}

let dbConnection: Sql | null = null;
let db: any = null;
let envFileCreated = false;
let migrationsRun = false;
let env: TestEnvironment | null = null;

export function getEnvironment(): TestEnvironment {
  if (!env) {
    throw new Error('Test environment is not initialized. Call ensureTestEnvironment() first.');
  }
  return env;
}

/**
 * Ensures the test environment is properly set up
 */
export async function ensureTestEnvironment(): Promise<TestEnvironment> {
  if (env) {
    return env;
  }
  console.log('🔧 Setting up test environment...');

  // Set up environment variables
  const testEnv = await setupEnvironment();

  // Start test database if needed
  await ensureTestDatabase();

  // Set up database schema
  await ensureDatabaseSchema();

  console.log('✅ Test environment ready');
  return testEnv;
}

/**
 * Sets up the test environment variables
 */
async function setupEnvironment(): Promise<TestEnvironment> {
  const testEnv: TestEnvironment = {
    DATABASE_URL: 'postgresql://test_user:test_password@localhost:5433/test_db',
    INTERNAL_API_SECRET: 'test-internal-secret-for-ci',
    API_SECRET: 'test-api-key-secret-for-ci',
    ADMIN_API_SECRET: 'test-admin-secret-for-ci',
    GATEWAY_URL: 'http://localhost:3000',
    NODE_ENV: 'test'
  };

  // Set environment variables
  Object.entries(testEnv).forEach(([key, value]) => {
    process.env[key] = value;
  });

  // Store for later retrieval
  env = testEnv;

  // Create .env.test file if it doesn't exist
  const gatewayDir = join(process.cwd());
  const envTestPath = join(gatewayDir, '.env.test');

  if (!existsSync(envTestPath)) {
    const envContent = Object.entries(testEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    await fs.writeFile(envTestPath, envContent);
    envFileCreated = true;
    console.log('📝 Created .env.test file');
  }

  return testEnv;
}

/**
 * Ensures test database is running and accessible
 */
async function ensureTestDatabase(): Promise<void> {
  console.log('🗄️  Checking test database...');

  try {
    // Try to connect to the database
    const client = postgres(process.env.DATABASE_URL!, { timeout: 5000 });
    await client`SELECT 1`;
    await client.end();
    console.log('✅ Test database is accessible');
    return;
  } catch (error) {
    console.log('⚠️  Test database not accessible, starting it...');
    await startTestDatabase();
  }
}

/**
 * Starts the test database using Docker
 */
async function startTestDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('🐳 Starting test database container...');

    // Stop existing container if it exists
    const stopCmd = spawn('docker', [
      'stop', 'whatsapp-gateway-saas-test-db'
    ], { stdio: 'pipe' });

    stopCmd.on('close', () => {
      const rmCmd = spawn('docker', [
        'rm', 'whatsapp-gateway-saas-test-db'
      ], { stdio: 'pipe' });

      rmCmd.on('close', () => {
        const runCmd = spawn('docker', [
          'run', '-d',
          '--name', 'whatsapp-gateway-saas-test-db',
          '-e', 'POSTGRES_USER=test_user',
          '-e', 'POSTGRES_PASSWORD=test_password',
          '-e', 'POSTGRES_DB=test_db',
          '-p', '5433:5432',
          '--restart', 'unless-stopped',
          'postgres:16-alpine'
        ], { stdio: 'pipe' });

        runCmd.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Test database container started');
            waitForDatabase().then(resolve).catch(reject);
          } else {
            reject(new Error('Failed to start test database container'));
          }
        });

        runCmd.on('error', reject);
      });

      rmCmd.on('error', () => {
        // Container might not exist, which is fine
        console.log('ℹ️  No existing container to remove');
        const runCmd = spawn('docker', [
          'run', '-d',
          '--name', 'whatsapp-gateway-saas-test-db',
          '-e', 'POSTGRES_USER=test_user',
          '-e', 'POSTGRES_PASSWORD=test_password',
          '-e', 'POSTGRES_DB=test_db',
          '-p', '5433:5432',
          '--restart', 'unless-stopped',
          'postgres:16-alpine'
        ], { stdio: 'pipe' });

        runCmd.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Test database container started');
            waitForDatabase().then(resolve).catch(reject);
          } else {
            reject(new Error('Failed to start test database container'));
          }
        });

        runCmd.on('error', reject);
      });
    });

    stopCmd.on('error', () => {
      // Container might not exist, which is fine
      console.log('ℹ️  No existing container to stop');
    });
  });
}

/**
 * Waits for the database to be ready
 */
async function waitForDatabase(): Promise<void> {
  console.log('⏳ Waiting for database to be ready...');

  for (let i = 0; i < 30; i++) {
    try {
      const client = postgres(process.env.DATABASE_URL!, { timeout: 5000 });
      await client`SELECT 1`;
      await client.end();
      console.log('✅ Database is ready');
      return;
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  throw new Error('Database failed to become ready within 30 seconds');
}

/**
 * Ensures the database schema is set up
 */
async function ensureDatabaseSchema(): Promise<void> {
  if (migrationsRun) {
    return;
  }

  console.log('🗃️  Setting up database schema...');

  try {
    // Try to connect and check if tables exist
    await connectToDatabase();

    // Check if tables exist by trying to query one of them
    try {
      await db.query.users.findFirst();
      console.log('✅ Database schema already exists');
      migrationsRun = true;
      return;
    } catch (error) {
      // Tables don't exist, need to run migrations
      console.log('🔄 Database schema needs to be created');
    }

    // Run migrations
    await runMigrations();
    migrationsRun = true;
    console.log('✅ Database schema created successfully');

  } catch (error) {
    console.error('❌ Failed to set up database schema:', error);
    throw error;
  }
}

/**
 * Connects to the database
 */
async function connectToDatabase(): Promise<void> {
  if (dbConnection) {
    return;
  }

  dbConnection = postgres(process.env.DATABASE_URL!);
  db = drizzle(dbConnection, { schema });
}

/**
 * Runs database migrations
 */
async function runMigrations(): Promise<void> {
  console.log('📦 Running database migrations...');

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');

    // First, generate migrations if they don't exist
    const generateCmd = spawn('npx', ['drizzle-kit', 'generate'], {
      cwd: join(process.cwd(), '..'),
      stdio: 'pipe'
    });

    generateCmd.on('close', (code: number | null) => {
      if (code === 0) {
        console.log('✅ Migrations generated');

        // Then run the migrations
        const migrateCmd = spawn('npx', ['drizzle-kit', 'migrate'], {
          cwd: join(process.cwd(), '..'),
          stdio: 'pipe'
        });

        migrateCmd.on('close', (code: number | null) => {
          if (code === 0) {
            console.log('✅ Migrations applied successfully');
            resolve();
          } else {
            reject(new Error('Migration failed'));
          }
        });

        migrateCmd.on('error', reject);
      } else {
        reject(new Error('Migration generation failed'));
      }
    });

    generateCmd.on('error', reject);
  });
}

/**
 * Gets the database connection for tests
 */
export async function getDb() {
  if (!db) {
    await connectToDatabase();
  }
  return db;
}

/**
 * Cleans up the test environment
 */
export async function cleanup(): Promise<void> {
  console.log('🧹 Cleaning up test environment...');

  if (dbConnection) {
    try {
      await dbConnection.end({ timeout: 5 });
      dbConnection = null;
      db = null;
    } catch (error) {
      console.warn('⚠️  Failed to close database connection:', error);
    }
  }

  if (envFileCreated) {
    try {
      const gatewayDir = join(process.cwd());
      const envTestPath = join(gatewayDir, '.env.test');
      await fs.unlink(envTestPath);
      console.log('🗑️  Removed .env.test file');
      envFileCreated = false; // Reset for next test run
    } catch (error) {
      console.warn('⚠️  Failed to remove .env.test file:', error);
    }
  }

  // Only clean up database container if explicitly requested or no other tests are running
  // This prevents cleanup conflicts when multiple test files are running
}

/**
 * Force cleanup of database container (for explicit cleanup only)
 */
export async function forceCleanup(): Promise<void> {
  console.log('🧹 Force cleaning up test environment...');

  if (dbConnection) {
    try {
      await dbConnection.end({ timeout: 5 });
      dbConnection = null;
      db = null;
    } catch (error) {
      console.warn('⚠️  Failed to close database connection:', error);
    }
  }

  if (envFileCreated) {
    try {
      const gatewayDir = join(process.cwd());
      const envTestPath = join(gatewayDir, '.env.test');
      await fs.unlink(envTestPath);
      console.log('🗑️  Removed .env.test file');
    } catch (error) {
      console.warn('⚠️  Failed to remove .env.test file:', error);
    }
  }

  // Stop test database container
  try {
    const { spawn } = require('child_process');
    const stopCmd = spawn('docker', ['stop', 'whatsapp-gateway-saas-test-db'], { stdio: 'pipe' });

    stopCmd.on('close', () => {
      const rmCmd = spawn('docker', ['rm', 'whatsapp-gateway-saas-test-db'], { stdio: 'pipe' });
      rmCmd.on('close', () => {
        console.log('✅ Test database container stopped and removed');
      });
    });
  } catch (error) {
    console.warn('⚠️  Failed to clean up test database container:', error);
  }
}