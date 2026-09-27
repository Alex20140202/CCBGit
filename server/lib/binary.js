/**
 * Deciding whether a blob is text.
 *
 * Shared by the blob reader and the upload path so that "is this file
 * displayable?" is answered the same way everywhere. Git has no such concept:
 * it stores bytes and leaves the question to whoever displays them.
 */

/** Byte patterns that are a strong signal for binary content. */
const CONTROL_BYTES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]);

/** How much of the file decides the answer. */
const SAMPLE_SIZE = 8000;

/** Above this share of suspicious bytes, treat the file as binary. */
const SUSPICIOUS_RATIO = 0.3;

/**
 * Heuristic, not a certainty: a file with no NUL and few control characters is
 * treated as text. UTF-16 and some compressed formats will slip through, which
 * is why the renderer also copes with invalid UTF-8 rather than trusting this.
 */
export function looksBinary(buffer) {
  if (!buffer || !buffer.length) return false;

  const sample = buffer.subarray(0, SAMPLE_SIZE);
  if (sample.includes(0)) return true;

  let suspicious = 0;
  for (const byte of sample) {
    if (CONTROL_BYTES.has(byte)) suspicious += 1;
  }

  return suspicious / sample.length > SUSPICIOUS_RATIO;
}

/** Does decoding this buffer produce a replacement character? */
export function hasInvalidUtf8(text) {
  return text.includes('\uFFFD');
}

export default looksBinary;
