import { AwsClient } from "aws4fetch";

import type { UploadAuthorization } from "@printgo/api-contract";

export const UPLOAD_URL_EXPIRY_SECONDS = 300;

export interface UploadSigner {
  createUploadAuthorization(objectKey: string): Promise<UploadAuthorization>;
}

export class R2UploadSigner implements UploadSigner {
  constructor(
    private readonly configuration: {
      accountId: string;
      bucketName: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
    private readonly now: () => number = Date.now,
  ) {}

  async createUploadAuthorization(
    objectKey: string,
  ): Promise<UploadAuthorization> {
    const requiredHeaders = {
      "Content-Type": "application/pdf",
      "If-None-Match": "*",
    } as const;
    const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `https://${this.configuration.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(this.configuration.bucketName)}/${encodedKey}`,
    );
    url.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_EXPIRY_SECONDS));
    const client = new AwsClient({
      accessKeyId: this.configuration.accessKeyId,
      secretAccessKey: this.configuration.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    const signed = await client.sign(url, {
      method: "PUT",
      headers: requiredHeaders,
      aws: { signQuery: true, allHeaders: true },
    });
    return {
      uploadUrl: signed.url,
      expiresAt: new Date(
        this.now() + UPLOAD_URL_EXPIRY_SECONDS * 1000,
      ).toISOString(),
      requiredHeaders,
    };
  }
}
