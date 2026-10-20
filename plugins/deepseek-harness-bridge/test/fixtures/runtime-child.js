import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'echo') {
  process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));
  process.stderr.write('stderr-中文');
  process.exitCode = 7;
} else if (mode === 'large') {
  const block = Buffer.alloc(65536, 'x');
  await Promise.all([process.stdout, process.stderr].map(async stream => {
    for (let index = 0; index < 32; index++) if (!stream.write(block)) await once(stream, 'drain');
  }));
} else if (mode === 'identity-large' || mode === 'active') {
  const [identityPath, completedPath] = args;
  await writeFile(identityPath, String(process.pid), { flag: 'wx' });
  const block = Buffer.alloc(65536, 'x');
  if (mode === 'active') {
    setInterval(() => { process.stdout.write(block); process.stderr.write(block); }, 20);
    // Bound the synthetic fixture even if the cancellation under test fails.
    setTimeout(() => { writeFile(completedPath, 'fixture-deadline', { flag: 'wx' }).finally(() => process.exit(0)); }, 10000);
  } else {
    await Promise.all([process.stdout, process.stderr].map(async stream => {
      for (let index = 0; index < 32; index++) if (!stream.write(block)) await once(stream, 'drain');
    }));
    await writeFile(completedPath, 'output-completed', { flag: 'wx' });
  }
} else { throw new Error('Unknown fixture mode'); }
