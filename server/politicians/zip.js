// Minimal ZIP reader for the House Clerk FD index. The archive is one or two
// deflated files (XML and the same rows as TSV). No extra dependency.

import zlib from 'node:zlib';

export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length) {
    const sig = buf.readUInt32LE(off);
    if (sig !== 0x04034b50) break;
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    let compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    if (flags & 0x08) {
      throw new Error(`ZIP entry ${name} uses a data descriptor, which this reader does not handle`);
    }
    if (dataStart + compSize > buf.length) {
      throw new Error(`ZIP entry ${name} runs past the end of the file`);
    }
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`ZIP method ${method} is not supported`);
    entries.push({ name, data });
    off = dataStart + compSize;
  }
  if (!entries.length) throw new Error('ZIP archive contained no files');
  return entries;
}

export function zipText(entries, suffix) {
  const hit = entries.find((e) => e.name.toLowerCase().endsWith(suffix));
  return hit ? hit.data.toString('utf8') : null;
}
