import { describe, expect, it } from "vitest";

import {
  hmacSha256Hex,
  HttpRazorpayClient,
  verifyHmacSha256Hex,
} from "./razorpay";

describe("Razorpay integration primitives", () => {
  it("validates HMAC-SHA256 signatures without accepting malformed values", async () => {
    const signature = await hmacSha256Hex("order_a|pay_a", "secret");
    await expect(
      verifyHmacSha256Hex("order_a|pay_a", signature, "secret"),
    ).resolves.toBe(true);
    await expect(
      verifyHmacSha256Hex("order_a|pay_b", signature, "secret"),
    ).resolves.toBe(false);
    await expect(
      verifyHmacSha256Hex("order_a|pay_a", "not-a-signature", "secret"),
    ).resolves.toBe(false);
  });

  it("creates provider orders with server amounts and Basic authentication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, ...(init ? { init } : {}) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "order_a",
            amount: 2100,
            currency: "INR",
            status: "created",
          }),
          { status: 200 },
        ),
      );
    };
    const client = new HttpRazorpayClient("key", "secret", fetcher);
    await expect(
      client.createOrder({
        amountPaise: 2100,
        currency: "INR",
        receipt: "pg_receipt",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ id: "order_a", amount: 2100 }),
    );
    const created = calls[0];
    expect(created?.url).toBe("https://api.razorpay.com/v1/orders");
    expect(created?.init?.method).toBe("POST");
    expect(created?.init?.body).toBe(
      JSON.stringify({ amount: 2100, currency: "INR", receipt: "pg_receipt" }),
    );
    expect(new Headers(created?.init?.headers).get("Authorization")).toMatch(
      /^Basic /u,
    );
  });
});
