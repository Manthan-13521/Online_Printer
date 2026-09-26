export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: "INR";
  status: string;
}

export interface RazorpayPayment {
  id: string;
  orderId: string;
  amount: number;
  currency: "INR";
  status: string;
}

export interface RazorpayClient {
  createOrder(input: {
    amountPaise: number;
    currency: "INR";
    receipt: string;
  }): Promise<RazorpayOrder>;
  fetchPayment(paymentId: string): Promise<RazorpayPayment>;
}

export class RazorpayProviderError extends Error {
  constructor() {
    super("Razorpay request failed.");
    this.name = "RazorpayProviderError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new RazorpayProviderError();
  return value;
}

function requiredAmount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new RazorpayProviderError();
  return value as number;
}

export class HttpRazorpayClient implements RazorpayClient {
  private readonly authorization: string;

  constructor(
    keyId: string,
    keySecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.authorization = `Basic ${btoa(`${keyId}:${keySecret}`)}`;
  }

  async createOrder(input: {
    amountPaise: number;
    currency: "INR";
    receipt: string;
  }): Promise<RazorpayOrder> {
    const response = await this.fetcher("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: this.authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body)) throw new RazorpayProviderError();
    const currency = requiredString(body.currency);
    if (currency !== "INR") throw new RazorpayProviderError();
    return {
      id: requiredString(body.id),
      amount: requiredAmount(body.amount),
      currency,
      status: requiredString(body.status),
    };
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    const response = await this.fetcher(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: this.authorization } },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body)) throw new RazorpayProviderError();
    const currency = requiredString(body.currency);
    if (currency !== "INR") throw new RazorpayProviderError();
    return {
      id: requiredString(body.id),
      orderId: requiredString(body.order_id),
      amount: requiredAmount(body.amount),
      currency,
      status: requiredString(body.status),
    };
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function hmacSha256Hex(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
    ),
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyHmacSha256Hex(
  payload: string,
  suppliedSignature: string,
  secret: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/iu.test(suppliedSignature)) return false;
  const expected = await hmacSha256Hex(payload, secret);
  return constantTimeEqual(expected, suppliedSignature.toLowerCase());
}
