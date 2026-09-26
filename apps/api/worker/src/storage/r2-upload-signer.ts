import { AwsClient } from "aws4fetch";

import type { UploadAuthorization } from "@printgo/api-contract";
import { PRINT_DOWNLOAD_AUTHORIZATION_MS } from "@printgo/domain";

export const UPLOAD_URL_EXPIRY_SECONDS = 300;

export interface UploadSigner {
  createUploadAuthorization(objectKey: string): Promise<UploadAuthorization>;
}

export interface DownloadAuthorization {
  url: string;
  expiresAtMs: number;
}
export interface DownloadSigner {
  createDownloadAuthorization(
    objectKey: string,
  ): Promise<DownloadAuthorization>;
}

export class R2UploadSigner implements UploadSigner, DownloadSigner {
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

  async createDownloadAuthorization(
    objectKey: string,
  ): Promise<DownloadAuthorization> {
    const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `https://${this.configuration.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(this.configuration.bucketName)}/${encodedKey}`,
    );
    url.searchParams.set(
      "X-Amz-Expires",
      String(PRINT_DOWNLOAD_AUTHORIZATION_MS / 1000),
    );
    const client = new AwsClient({
      accessKeyId: this.configuration.accessKeyId,
      secretAccessKey: this.configuration.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    const signed = await client.sign(url, {
      method: "GET",
      aws: { signQuery: true },
    });
    return {
      url: signed.url,
      expiresAtMs: this.now() + PRINT_DOWNLOAD_AUTHORIZATION_MS,
    };
  }
}
