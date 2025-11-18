import {} from 'bun:test'; // Import to load bun test types for globals
import { testSetup } from './utils/test-setup';

// Global setup for all tests
beforeAll(async () => {
  console.log('🚀 Setting up global test environment...');
  await testSetup.ensureTestEnvironment();
}, 60000);

// Global cleanup after all tests
afterAll(async () => {
  console.log('🧹 Cleaning up global test environment...');
  await testSetup.cleanup();
}, 30000);

// Handle unhandled promise rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions in tests
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});