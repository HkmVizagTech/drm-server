// Object storage, on Cloudflare R2.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
// DRM is live. Nothing here may become a dependency of anything that already
// works. Uploading a sheet, sharing a QR and reprinting a receipt all worked
// before there was a bucket and must keep working if the bucket is missing,
// misconfigured, full, or simply down.
//
// So every function is written to fail soft: a write that cannot happen is
// logged and reported, never thrown at a request that has already succeeded;
// a read that misses falls through to whatever the old path was. isConfigured()
// is the switch, and the screens ask it rather than assuming.
//
// WHY R2 AND NOT S3
// It is S3-compatible, so this is the ordinary AWS client pointed at a
// different endpoint, and Cloudflare does not charge for egress - which matters
// because the thing most often read back out of here is a receipt PDF a donor
// is downloading.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const ACCOUNT = process.env.R2_ACCOUNT_ID ?? '';
const KEY = process.env.R2_ACCESS_KEY_ID ?? '';
const SECRET = process.env.R2_SECRET_ACCESS_KEY ?? '';
const BUCKET = process.env.R2_BUCKET ?? '';
/**
 * The public base URL, for objects donors fetch directly - a branded QR image
 * on its way into a WhatsApp message.
 *
 * Optional, and its absence is meaningful rather than an error: with no public
 * URL the bucket is private, and anything a donor must reach is served through
 * DRM instead. Only set this for a bucket you have deliberately made public.
 */
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

let client: S3Client | null = null;

export function isConfigured(): boolean {
  return !!(ACCOUNT && KEY && SECRET && BUCKET);
}

/** True when objects can be given a URL a donor's phone can open. */
export const hasPublicUrls = (): boolean => isConfigured() && !!PUBLIC_BASE;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      // R2_ENDPOINT lets this point somewhere else - a test double, or a
      // different S3-compatible provider if the temple ever moves off R2.
      // Unset, it is the ordinary R2 endpoint for the account.
      endpoint: process.env.R2_ENDPOINT || `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
      // Path style, which R2 supports and which keeps the bucket out of the
      // hostname. Virtual-host style would put it there, and a bucket name
      // with a dot in it then breaks TLS for reasons nobody enjoys diagnosing.
      forcePathStyle: true,
    });
  }
  return client;
}

export interface PutResult {
  ok: boolean;
  key?: string;
  url?: string | null;
  error?: string;
}

/**
 * Store an object.
 *
 * Returns a result rather than throwing. Every caller of this is finishing
 * something that has already happened - a sheet that is already imported, a
 * receipt already issued - and turning a storage hiccup into a failed request
 * would undo real work over a cache miss.
 */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
  opts: { cacheSeconds?: number } = {}
): Promise<PutResult> {
  if (!isConfigured()) return { ok: false, error: 'not-configured' };
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Long and immutable by default, because every key this codebase
        // writes is content-addressed - the key changes when the content
        // does, so an object can never need invalidating.
        CacheControl: `public, max-age=${opts.cacheSeconds ?? 31536000}, immutable`,
      })
    );
    return { ok: true, key, url: publicUrl(key) };
  } catch (e) {
    console.error('storage.put error:', (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/** Fetch an object, or null if it is not there. Never throws. */
export async function getObject(key: string): Promise<Buffer | null> {
  if (!isConfigured()) return null;
  try {
    const r = await getClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!r.Body) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of r.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch {
    // A miss and an outage look the same from here, and the answer is the
    // same either way: fall back to wherever the data came from originally.
    return null;
  }
}

export async function objectExists(key: string): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** The public URL for a key, when the bucket has one. */
export function publicUrl(key: string): string | null {
  return hasPublicUrls() ? `${PUBLIC_BASE}/${key}` : null;
}

/* ------------------------------------------------------------------- keys */

/** Keep a filename recognisable without letting it dictate a path. */
export function safeName(name: string): string {
  return (
    String(name ?? '')
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .slice(-120) || 'file'
  );
}

/**
 * Where each kind of thing lives.
 *
 * Grouped by year for the ones that accumulate, so a bucket listing after five
 * years is still navigable by a human going in with the Cloudflare console.
 */
export const keys = {
  /** The office's original workbook, exactly as it arrived. */
  importFile: (batchId: string, filename: string) =>
    `imports/${new Date().getFullYear()}/${batchId}/${safeName(filename)}`,

  /** A branded QR image an admin uploaded. Donors fetch this one directly. */
  qrImage: (qrRowId: string, ext: string) => `qr/${qrRowId}.${ext}`,

  /**
   * A cached receipt PDF.
   *
   * Content-addressed on purpose - see receiptFingerprint below. The hash is
   * part of the key, so a corrected or reissued receipt is a DIFFERENT object
   * and the stale one is simply never asked for again. There is no
   * invalidation step to forget.
   */
  receipt: (site: string, externalId: string, fingerprint: string) =>
    `receipts/${site}/${externalId}/${fingerprint}.pdf`,
};
