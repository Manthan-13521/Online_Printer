import * as zlib from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Buffer | string;
}

/**
 * Lightweight, zero-dependency ZIP archive generator.
 * Produces standard PKZip 2.0 archives compatible with Windows Explorer, unzip, and 7-Zip.
 */
export function buildZipArchive(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const rawData = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const compressedData = zlib.deflateRawSync(rawData);
    // Use deflate if smaller, otherwise store uncompressed
    const useDeflate = compressedData.length < rawData.length;
    const dataToStore = useDeflate ? compressedData : rawData;
    const compressionMethod = useDeflate ? 8 : 0;

    const nameBytes = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const crc = crc32(rawData);

    // Local file header (30 bytes + name length)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(compressionMethod, 8); // compression method
    localHeader.writeUInt16LE(0, 10); // last mod file time
    localHeader.writeUInt16LE(0, 12); // last mod file date
    localHeader.writeUInt32LE(crc, 14); // crc-32
    localHeader.writeUInt32LE(dataToStore.length, 18); // compressed size
    localHeader.writeUInt32LE(rawData.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26); // file name length
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    localHeaders.push(localHeader, dataToStore);

    // Central directory header (46 bytes + name length)
    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(compressionMethod, 10); // compression method
    centralHeader.writeUInt16LE(0, 12); // last mod file time
    centralHeader.writeUInt16LE(0, 14); // last mod file date
    centralHeader.writeUInt32LE(crc, 16); // crc-32
    centralHeader.writeUInt32LE(dataToStore.length, 20); // compressed size
    centralHeader.writeUInt32LE(rawData.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBytes.length, 28); // file name length
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    nameBytes.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + dataToStore.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce(
    (acc, cur) => acc + cur.length,
    0,
  );

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where central dir starts
  eocd.writeUInt16LE(entries.length, 8); // total entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries in central dir
  eocd.writeUInt32LE(centralDirSize, 12); // size of central dir
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// Standard CRC32 table implementation
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const tableVal = crcTable[(crc ^ byte) & 0xff] ?? 0;
    crc = tableVal ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
