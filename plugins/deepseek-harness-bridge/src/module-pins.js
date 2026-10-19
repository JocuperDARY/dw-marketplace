import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';

// Hooks run in the worker before its module graph loads. Keep original URLs so
// relative and package imports retain their normal resolution base.
export function registerModulePins(entries, { runtimePeers = false } = {}) {
  const pins = new Map(entries);
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      // Native packages are installed by another host and can otherwise resolve
      // stale peer SDK copies from an old npm cache. One worker must share its
      // locked runtime types, scoped services and descriptor protocol.
      const resolved = nextResolve(specifier, runtimePeers && specifier.startsWith('@deepseek-ai/')
        ? { ...context, parentURL: import.meta.url } : context);
      if (pins.has(specifier) && resolved.url !== specifier) throw new Error('Pinned module identity changed.');
      return resolved;
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!pins.has(url)) return loaded;
      const source = loaded.source;
      if (!(typeof source === 'string' || ArrayBuffer.isView(source) || source instanceof ArrayBuffer)) {
        throw new Error('Pinned module format does not expose verifiable source.');
      }
      const bytes = typeof source === 'string' ? Buffer.from(source) : source instanceof ArrayBuffer
        ? Buffer.from(source) : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
      if (createHash('sha256').update(bytes).digest('hex') !== pins.get(url)) throw new Error('Pinned module source changed.');
      return loaded;
    },
  });
}
