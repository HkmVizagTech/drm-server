// How long a recording is, read from the file itself.
//
// WHY THE FILE AND NOT A TYPED NUMBER
// A talk time somebody typed is a claim; the length of the recording is a
// fact, and the recording is the proof the talk happened. Calls a caller adds
// by hand (routes/unmatchedCalls.ts) therefore take their talk time from the
// file or are refused - there is no field to type one into.
//
// mp3, m4a/mp4/3gp (AAC), wav, ogg and opus are read by music-metadata. AMR,
// which a few phones record in, is not, so its frames are counted here: every
// frame is 20 ms and its first byte says how long the frame is.

import { parseBuffer } from 'music-metadata';

// Bytes of speech in a frame, by frame type, after the one-byte header.
const AMR_NB_BYTES = [12, 13, 15, 17, 19, 20, 26, 31, 5, 6, 5, 5, 0, 0, 0, 0];
const AMR_WB_BYTES = [17, 23, 32, 36, 40, 46, 50, 58, 60, 5, 0, 0, 0, 0, 0, 0];

/** Seconds of audio in an AMR file, or null if it does not parse as one. */
export function amrSeconds(buf: Buffer): number | null {
  const nb = buf.subarray(0, 6).toString('latin1') === '#!AMR\n';
  const wb = buf.subarray(0, 9).toString('latin1') === '#!AMR-WB\n';
  if (!nb && !wb) return null;
  const table = wb ? AMR_WB_BYTES : AMR_NB_BYTES;
  let at = wb ? 9 : 6;
  let frames = 0;
  while (at < buf.length) {
    const type = (buf[at] >> 3) & 0x0f;
    frames += 1;
    at += 1 + table[type];
  }
  return frames > 0 ? frames * 0.02 : null;
}

/**
 * Whole seconds of audio in the file, or null when its length cannot be read.
 *
 * The file is read by what is in it, not by the name it came with. A 3GP file
 * is not recognised that way but is the same container as MP4, so it gets a
 * second try as one.
 */
export async function recordingSeconds(buf: Buffer): Promise<number | null> {
  const amr = amrSeconds(buf);
  if (amr !== null) return Math.round(amr);
  for (const hint of [undefined, 'audio/mp4']) {
    try {
      const meta = await parseBuffer(buf, hint ? { mimeType: hint } : undefined, { duration: true });
      const d = meta.format.duration;
      if (typeof d === 'number' && Number.isFinite(d) && d > 0) return Math.round(d);
    } catch {
      // Try the next reading.
    }
  }
  return null;
}
