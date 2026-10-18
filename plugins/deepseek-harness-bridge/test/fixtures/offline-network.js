// Test-only preload: the real SDK runtime may use stdio and files, never a network.
import { Socket } from 'node:net';
Socket.prototype.connect = function () { throw new Error('Offline SDK test forbids network connections'); };
