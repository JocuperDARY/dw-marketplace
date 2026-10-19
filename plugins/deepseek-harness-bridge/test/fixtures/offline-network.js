// Test-only preload: the real SDK runtime may use stdio and files, never a network.
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
Socket.prototype.connect = function () { throw new Error('Offline SDK test forbids network connections'); };
// Default profile resolution must not read the operator's live Bridge config.
// No directory is created; tests of configuration use explicit fixture paths.
process.env.DSH_BRIDGE_CONFIG_DIR = join(tmpdir(), `bridge-offline-empty-config-${randomUUID()}`);
