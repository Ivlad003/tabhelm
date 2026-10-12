// Chrome Native Messaging framing: each message is a 4-byte little-endian
// length followed by UTF-8 JSON. stdout is reserved for these frames, so
// nothing else in the host may write to it.

const MAX_TO_CHROME = 1024 * 1024; // Chrome rejects host->extension frames above 1 MB

export function createNativeChannel({ input = process.stdin, output = process.stdout, onMessage, onClose }) {
  let buffer = Buffer.alloc(0);

  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const body = buffer.subarray(4, 4 + len).toString('utf8');
      buffer = buffer.subarray(4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch (err) {
        process.stderr.write(`[native] bad message: ${err.message}\n`);
      }
    }
  });
  input.on('end', () => onClose?.());
  input.on('close', () => onClose?.());

  function send(message) {
    let json = JSON.stringify(message);
    if (Buffer.byteLength(json) > MAX_TO_CHROME) {
      json = JSON.stringify({
        type: 'error',
        tabId: message.tabId,
        message: `Message of type "${message.type}" exceeded the 1 MB native messaging limit and was dropped.`,
      });
    }
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    output.write(Buffer.concat([header, body]));
  }

  return { send };
}
