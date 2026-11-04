import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { AppError } from './errors';

/**
 * Requests to addresses chosen by third parties (video extensions: manifests, stream lists,
 * streams, playlists, segments, subtitles). An extension must not reach the LAN, the host, the
 * other containers or a cloud metadata service, so:
 *
 * - every address is checked where the connection is made (the DNS answer actually used, which
 *   defeats DNS rebinding), IPv4 and IPv6, literal or resolved;
 * - redirects are followed by hand, each hop checked the same way;
 * - only the headers the caller passes are sent (never Bunko's cookies or other services' keys),
 *   and credentials are dropped when a redirect leaves the origin;
 * - connection, first-byte and idle timeouts; callers cap body sizes.
 *
 * Self-hosted services on the LAN (an addon aggregator, a file server) are allowed by the
 * administrator only, with BUNKO_VIDEO_ALLOWED_HOSTS: host names (optionally host:port) or
 * CIDR ranges, comma separated. Users cannot widen it from the interface.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** IPv4 written inside an IPv6 address (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96). */
function embeddedIpv4(address: string) {
  const lower = address.toLowerCase();
  const m = /^(?:::ffff:|64:ff9b::)(?:0:)?([0-9a-f.:]+)$/.exec(lower);
  if (!m) return null;
  if (isIP(m[1]) === 4) return m[1];
  const parts = m[1].split(':');
  if (parts.length !== 2) return null;
  const hi = parseInt(parts[0], 16);
  const lo = parseInt(parts[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4) return !blocked.check(v4, 'ipv4');
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

interface Allowance {
  hosts: Set<string>;
  ranges: BlockList;
}
let allowanceCache: { raw: string; value: Allowance } | undefined;
function allowance(): Allowance {
  const raw = process.env.BUNKO_VIDEO_ALLOWED_HOSTS ?? '';
  if (allowanceCache?.raw === raw) return allowanceCache.value;
  const value: Allowance = { hosts: new Set(), ranges: new BlockList() };
  for (const item of raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)) {
    const cidr = /^([0-9a-f.:]+)\/(\d{1,3})$/.exec(item);
    if (cidr && isIP(cidr[1])) {
      value.ranges.addSubnet(cidr[1], Number(cidr[2]), isIP(cidr[1]) === 4 ? 'ipv4' : 'ipv6');
      continue;
    }
    if (isIP(item)) {
      value.ranges.addAddress(item, isIP(item) === 4 ? 'ipv4' : 'ipv6');
      continue;
    }
    value.hosts.add(item);
  }
  allowanceCache = { raw, value };
  return value;
}
const hostAllowed = (url: URL) => {
  const { hosts } = allowance();
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    hosts.has(host) || hosts.has(`${host}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`)
  );
};
const addressAllowed = (address: string) => {
  const { ranges } = allowance();
  const family = isIP(address);
  return family !== 0 && ranges.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

/** Whether this address may be fetched as far as can be told without DNS (literal IPs, names). */
export function plausiblyPublic(raw: string) {
  return plausibly(raw, true);
}
/**
 * Whether the address looks public by itself, without the administrator's allowance: a service
 * allowed on the LAN or the Docker network (`addon:7000`) is reachable by Bunko, not by the
 * viewer's browser, so its streams only play through the relay.
 */
export function onPublicInternet(raw: string) {
  return plausibly(raw, false);
}
function plausibly(raw: string, allowance: boolean) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (allowance && hostAllowed(url)) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicAddress(host) || (allowance && addressAllowed(host));
  // Single-label and local names resolve inside the LAN or the Docker network.
  return host.includes('.') && !/\.(?:local|localhost|internal|lan|home|arpa)$/i.test(host);
}

const refused = () =>
  new AppError('DESTINATION_REFUSED', 'This address is on a private network', 403);

/** DNS lookup that only returns addresses the policy allows (used by the socket itself). */
function guardedLookup(trusted: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = (addresses as LookupAddress[]).filter(
        (a) => trusted || isPublicAddress(a.address) || addressAllowed(a.address),
      );
      if (!list.length) return callback(refused() as NodeJS.ErrnoException, '', 0);
      if ((options as { all?: boolean }).all)
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  /** Final address after redirects. */
  url: string;
  body: ReadableStream<Uint8Array>;
  /** Stop reading (frees the connection). */
  cancel: () => void;
}
export interface SafeFetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Until the response headers arrive (each hop). Default 15 s. */
  timeoutMs?: number;
  /** Silence allowed while reading the body. Default 60 s. */
  idleMs?: number;
  maxRedirects?: number;
}

const CREDENTIALS = /^(authorization|cookie|proxy-authorization)$/i;

function once(url: URL, options: SafeFetchOptions): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const trusted = hostAllowed(url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !trusted && !isPublicAddress(host) && !addressAllowed(host))
      return reject(refused());
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': 'Bunko', Accept: '*/*', ...(options.headers ?? {}) },
        lookup: guardedLookup(trusted),
        agent: false,
        signal: options.signal,
      },
      (response) => {
        clearTimeout(firstByte);
        response.setTimeout(options.idleMs ?? 60_000, () =>
          response.destroy(new Error('Idle timeout')),
        );
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
        resolve({
          status: response.statusCode ?? 502,
          headers,
          url: url.toString(),
          body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
          cancel: () => response.destroy(),
        });
      },
    );
    const firstByte = setTimeout(
      () => request.destroy(new AppError('STREAM_TIMEOUT', 'The address did not answer', 504)),
      options.timeoutMs ?? 15_000,
    );
    request.on('error', (error) => {
      clearTimeout(firstByte);
      reject(error);
    });
    request.end();
  });
}

/**
 * GET an address chosen by a third party under the network policy above. Throws
 * DESTINATION_REFUSED (private address), STREAM_TIMEOUT, or STREAM_UNREACHABLE.
 */
export async function safeFetch(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Invalid address', 400);
  }
  let headers = { ...(options.headers ?? {}) };
  const origin = url.origin;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new AppError('VALIDATION_ERROR', 'Not a web address', 400);
    if (url.username || url.password)
      throw new AppError('VALIDATION_ERROR', 'Invalid address', 400);
    let response: SafeResponse;
    try {
      response = await once(url, { ...options, headers });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: string }).code === 'DESTINATION_REFUSED') throw refused();
      if ((error as Error).name === 'AbortError') throw error;
      throw new AppError('STREAM_UNREACHABLE', 'The address could not be reached', 502);
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || response.status === 304 || !location)
      return response;
    response.cancel();
    if (hop >= (options.maxRedirects ?? 5))
      throw new AppError('STREAM_UNREACHABLE', 'Too many redirects', 502);
    const next = new URL(location, url);
    if (next.origin !== origin)
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIALS.test(k)));
    url = next;
  }
}

/** Reads a whole body, refusing more than `limit` bytes. */
export async function readCapped(response: SafeResponse, limit: number) {
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new AppError('PAYLOAD_TOO_LARGE', 'The response is too large', 502);
      chunks.push(part.value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
    response.cancel();
  }
  return Buffer.concat(chunks);
}

/** JSON from an extension endpoint (manifest, stream or subtitle list), at most 4 MiB. */
export async function safeJson(url: string, options: SafeFetchOptions = {}) {
  const response = await safeFetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    throw new AppError('ADDON_HTTP_ERROR', `HTTP ${response.status}`, 502);
  }
  const text = (await readCapped(response, 4 * 1024 * 1024)).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('ADDON_INVALID', 'The extension did not answer with JSON', 502);
  }
}
