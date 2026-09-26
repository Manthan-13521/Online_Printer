export type UploadVerificationResult =
  | { ok: true; sizeBytes: number }
  | {
      ok: false;
      code:
        | "OBJECT_MISSING"
        | "EMPTY_OBJECT"
        | "SIZE_MISMATCH"
        | "PDF_TOO_LARGE"
        | "INVALID_PDF";
    };

export interface PrivateObjectStore {
  head(key: string): Promise<{ size: number } | null>;
  readPrefix(key: string, length: number): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

export class R2PrivateObjectStore implements PrivateObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async head(key: string): Promise<{ size: number } | null> {
    const object = await this.bucket.head(key);
    return object ? { size: object.size } : null;
  }

  async readPrefix(key: string, length: number): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(key, { range: { offset: 0, length } });
    return object ? object.arrayBuffer() : null;
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }
}

export async function verifyPdfObject(
  store: PrivateObjectStore,
  input: { key: string; expectedSizeBytes: number; maximumSizeBytes: number },
): Promise<UploadVerificationResult> {
  const metadata = await store.head(input.key);
  if (!metadata) return { ok: false, code: "OBJECT_MISSING" };
  if (metadata.size <= 0) return { ok: false, code: "EMPTY_OBJECT" };
  if (metadata.size !== input.expectedSizeBytes) {
    return { ok: false, code: "SIZE_MISMATCH" };
  }
  if (metadata.size > input.maximumSizeBytes) {
    return { ok: false, code: "PDF_TOO_LARGE" };
  }
  const prefix = await store.readPrefix(
    input.key,
    Math.min(metadata.size, 1024),
  );
  if (!prefix || !new TextDecoder("latin1").decode(prefix).includes("%PDF-")) {
    return { ok: false, code: "INVALID_PDF" };
  }
  return { ok: true, sizeBytes: metadata.size };
}
