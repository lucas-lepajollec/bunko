import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';

// Explicit, versioned parameters: 32 MiB working set plus overhead.
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const prefix = 'scrypt$v1$32768$8$1';
const keyLength = 64;
// Unknown usernames take the same scrypt + timingSafeEqual path as wrong passwords.
const dummyHash = `${prefix}$${'00'.repeat(16)}$${'00'.repeat(keyLength)}`;
// Bound concurrent scrypt work so parallel login floods cannot exhaust Node RAM/CPU.
const MAX_CONCURRENT_SCRYPT = 4;
const MAX_QUEUED_SCRYPT = 16;
let activeScrypt = 0;
const scryptQueue: (() => void)[] = [];

async function withScryptSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeScrypt >= MAX_CONCURRENT_SCRYPT) {
    if (scryptQueue.length >= MAX_QUEUED_SCRYPT)
      throw new AppError('RATE_LIMITED', 'Try again in one minute', 429);
    await new Promise<void>((resolve) => scryptQueue.push(resolve));
  }
  activeScrypt++;
  try {
    return await run();
  } finally {
    activeScrypt--;
    scryptQueue.shift()?.();
  }
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return withScryptSlot(
    () =>
      new Promise((resolve, reject) => {
        scrypt(password, salt, keyLength, options, (error, key) => {
          if (error) reject(error);
          else resolve(key);
        });
      }),
  );
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${prefix}$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const valid =
    stored !== null && /^scrypt\$v1\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored);
  const parts = (valid ? stored : dummyHash).split('$');
  const key = await derive(password, Buffer.from(parts[5], 'hex'));
  const matches = timingSafeEqual(key, Buffer.from(parts[6], 'hex'));
  return valid && matches;
}
