const MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024;
function sizeError() { const error = new Error('Request exceeds size limit'); error.status = 413; return error; }
function readNodeBody(incoming, maxBytes = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    incoming.on('error', reject);
    if (Number(incoming.headers?.['content-length']) > maxBytes) { incoming.resume(); reject(sizeError()); return; }
    const chunks = []; let bytes = 0; let failed = false;
    incoming.on('data', (raw) => {
      if (failed) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); bytes += chunk.length;
      if (bytes > maxBytes) { failed = true; chunks.length = 0; reject(sizeError()); return; }
      chunks.push(chunk);
    });
    incoming.on('end', () => { if (!failed) resolve(chunks.length ? Buffer.concat(chunks) : undefined); });
    incoming.on('aborted', () => { const error = new Error('Request body aborted'); error.status = 400; reject(error); });
  });
}
module.exports = { MAX_HTTP_BODY_BYTES, readNodeBody };
