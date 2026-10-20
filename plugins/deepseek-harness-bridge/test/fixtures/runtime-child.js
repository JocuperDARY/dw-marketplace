import { once } from 'node:events';
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
} else { throw new Error('Unknown fixture mode'); }
