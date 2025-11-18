import { describe, test, expect } from 'bun:test';
import { sanitizeForContainerName, parseMemory } from '../../src/docker.service';

describe('Docker Service Utilities', () => {
    describe('sanitizeForContainerName', () => {
        test('should convert to lowercase', () => {
            expect(sanitizeForContainerName('MyContainer')).toBe('mycontainer');
        });

        test('should replace spaces with hyphens', () => {
            expect(sanitizeForContainerName('my container name')).toBe('my-container-name');
        });

        test('should replace multiple special characters with a single hyphen', () => {
            expect(sanitizeForContainerName('my@#$container--_name')).toBe('my-container-_name');
        });

        test('should collapse consecutive hyphens', () => {
            expect(sanitizeForContainerName('my---container')).toBe('my-container');
        });

        test('should handle empty string', () => {
            expect(sanitizeForContainerName('')).toBe('');
        });

        test('should allow valid characters like dots and underscores', () => {
            expect(sanitizeForContainerName('my_container.v1')).toBe('my_container.v1');
        });
    });

    describe('parseMemory', () => {
        test('should parse megabytes (m)', () => {
            expect(parseMemory('512m')).toBe(512 * 1024 * 1024);
        });

        test('should parse gigabytes (g)', () => {
            expect(parseMemory('2g')).toBe(2 * 1024 * 1024 * 1024);
        });
        
        test('should parse kilobytes (k)', () => {
            expect(parseMemory('256k')).toBe(256 * 1024);
        });

        test('should handle uppercase units', () => {
            expect(parseMemory('512M')).toBe(512 * 1024 * 1024);
            expect(parseMemory('2G')).toBe(2 * 1024 * 1024 * 1024);
        });

        test('should return 0 for empty string', () => {
            expect(parseMemory('')).toBe(0);
        });

        test('should return 0 for invalid string', () => {
            expect(parseMemory('invalid')).toBe(0);
        });

        test('should treat number string as bytes', () => {
            expect(parseMemory('1024')).toBe(1024);
        });
    });
});