import { beforeAll, afterAll } from 'bun:test';
import { ensureTestEnvironment, cleanup } from './utils/test-setup';

// Global setup for all tests
beforeAll(async () => {
  console.log('🚀 Setting up global test environment...');
  await ensureTestEnvironment();
}, 60000);

// Global cleanup after all tests
afterAll(async () => {
  console.log('🧹 Cleaning up global test environment...');
  await cleanup();
}, 30000);

// Handle unhandled promise rejections in tests
process.on('unhandledRejection', async (reason, promise) => {
  await cleanup();
});

// Handle uncaught exceptions in tests
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});