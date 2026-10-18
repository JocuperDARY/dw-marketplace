import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { requireValue } from './errors.js';

const MAX_FILE_BYTES = 262144;
const PROTECTED = /^(?:\.git|\.codex|\.agents|\.claude|\.dsh|\.aws|\.ssh|\.env(?:\..*)?|\.credentials(?:\..*)?|credentials(?:\..*)?|api-key\.dpapi|DeepSeekHarnessBridge|node_modules)$/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (root, target) => {
  const value = relative(root, target);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
};

/** A bounded tool boundary for a cooperative local workspace, not an OS sandbox. */
export class WorkspaceFiles {
  constructor({ workspace, access, backupDir, maxToolCalls }) {
    this.workspace = workspace;
    this.access = access;
    this.backupDir = backupDir;
    this.maxToolCalls = maxToolCalls;
    this.calls = 0;
    this.operations = Promise.resolve();
  }

  run(operation, signal) {
    const pending = this.operations.then(async () => {
      signal?.throwIfAborted();
      requireValue(++this.calls <= this.maxToolCalls, 'TOOL_LIMIT', 'The file tool call limit has been reached. Return the available evidence.');
      return operation();
    });
    this.operations = pending.catch(() => {});
    return pending;
  }

  async resolve(path, allowMissing = false) {
    requireValue(typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.includes('\0') &&
      !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes(':'), 'PATH_DENIED', 'Use a relative workspace path.');
    const parts = path.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.');
    requireValue(parts.every(part => part !== '..' && !PROTECTED.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(part)),
      'PATH_DENIED', 'Parent traversal, protected metadata and ambiguous path components are unavailable.');
    requireValue(await realpath(this.workspace) === this.workspace, 'WORKSPACE_CHANGED', 'Workspace identity changed.');
    let target = this.workspace;
    for (let index = 0; index < parts.length; index++) {
      target = join(target, parts[index]);
      let info;
      try { info = await lstat(target); }
      catch (error) {
        if (error.code === 'ENOENT' && allowMissing && index === parts.length - 1) return target;
        throw error;
      }
      requireValue(!info.isSymbolicLink(), 'PATH_DENIED', 'Symbolic links and junctions are unavailable.');
      requireValue(index === parts.length - 1 || info.isDirectory(), 'PATH_DENIED', 'Parent path must be a directory.');
      requireValue(contained(this.workspace, await realpath(target)), 'PATH_DENIED', 'Resolved path escaped the workspace.');
    }
    return target;
  }

  async readBytes(target) {
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      requireValue(info.isFile() && info.nlink === 1, 'PATH_DENIED', 'Only ordinary files with one link are available.');
      requireValue(info.size <= MAX_FILE_BYTES, 'FILE_LIMIT', 'File is larger than 256 KiB.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      requireValue(length <= MAX_FILE_BYTES, 'FILE_LIMIT', 'File grew beyond 256 KiB.');
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }

  list(path = '.', signal) {
    return this.run(async () => {
      const directory = await opendir(await this.resolve(path));
      const entries = [];
      let truncated = false;
      let visited = 0;
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++visited > 1000) { truncated = true; break; }
        if (PROTECTED.test(entry.name) || entry.isSymbolicLink() || /[. ]$/.test(entry.name)) continue;
        if (entry.isFile() || entry.isDirectory()) entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
      }
      return { entries, truncated };
    }, signal);
  }

  read(path, signal) {
    return this.run(async () => {
      const bytes = await this.readBytes(await this.resolve(path));
      requireValue(!bytes.includes(0), 'BINARY_FILE', 'Only UTF-8 text files are available.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { requireValue(false, 'BINARY_FILE', 'Only UTF-8 text files are available.'); }
      return { path, sha256: digest(bytes), text };
    }, signal);
  }

  write(path, text, expectedSha256, signal) {
    return this.run(async () => {
      requireValue(this.access === 'workspace-write', 'READ_ONLY', 'This task only has read access.');
      requireValue(typeof text === 'string' && Buffer.byteLength(text) <= MAX_FILE_BYTES && !text.includes('\0'), 'FILE_LIMIT', 'Write UTF-8 text of at most 256 KiB.');
      requireValue(expectedSha256 === 'new' || /^[a-f0-9]{64}$/.test(expectedSha256 ?? ''), 'INVALID_ARGUMENT', 'Supply the last read sha256 or new for a new file.');
      const target = await this.resolve(path, expectedSha256 === 'new');
      signal?.throwIfAborted();
      if (expectedSha256 === 'new') {
        await writeFile(target, text, { flag: 'wx', mode: 0o600, signal });
      } else {
        const previous = await this.readBytes(target);
        requireValue(digest(previous) === expectedSha256, 'FILE_CHANGED', 'File changed since it was read. Read it again before writing.');
        await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
        const backupName = `${digest(Buffer.from(path))}-${expectedSha256}.txt`;
        try { await writeFile(join(this.backupDir, backupName), previous, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await this.resolve(path);
        const handle = await open(target, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await handle.stat();
          requireValue(info.isFile() && info.nlink === 1 && info.size === previous.length, 'FILE_CHANGED', 'File identity or size changed.');
          const current = Buffer.alloc(previous.length);
          const { bytesRead } = await handle.read(current, 0, current.length, 0);
          requireValue(bytesRead === previous.length && digest(current) === expectedSha256, 'FILE_CHANGED', 'File content changed.');
          signal?.throwIfAborted();
          // No cancellation point between truncation and write; the bounded write must settle.
          await handle.truncate(0);
          await handle.writeFile(text, 'utf8');
        } finally { await handle.close(); }
      }
      return { path, sha256: digest(Buffer.from(text)), bytes: Buffer.byteLength(text) };
    }, signal);
  }
}
