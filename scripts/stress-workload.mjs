import { createHmac, randomBytes } from "node:crypto";
export const pdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
);
export function workload(runtime, request) {
  const sign = (body, key) =>
    createHmac("sha256", key).update(body).digest("hex");
  async function heartbeat(index = 0) {
    const response = await request("agent-heartbeat", "/api/agent/heartbeat", {
      method: "POST",
      token: runtime.agentTokens[index],
      body: {
        agentVersion: "audit",
        operationalState: "ONLINE",
        printers: [
          {
            windowsPrinterName: `Synthetic ${index}`,
            displayName: `Synthetic ${index}`,
            isDefault: true,
            status: "ONLINE",
            statusReason: null,
            capabilities: { colour: false, duplex: false, paperSizes: ["A4"] },
          },
        ],
      },
    });
    const job = response.data?.printJob;
    if (job) {
      const row = runtime.db
        .prepare("SELECT r2_object_key FROM uploads WHERE order_id=?")
        .get(job.orderId);
      if (job.currentStep.type === "CUSTOMER_DOCUMENT")
        await runtime.env.PDF_BUCKET.get(row.r2_object_key);
      const path = `/api/agent/print-jobs/${job.orderId}/steps/${job.currentStep.stepId}`;
      const base = { claimId: job.claimId };
      await request("print-start", `${path}/start`, {
        method: "POST",
        token: runtime.agentTokens[index],
        body: base,
      });
      await request("print-submitted", `${path}/submitted`, {
        method: "POST",
        token: runtime.agentTokens[index],
        body: { ...base, spoolerJobId: "synthetic-spool" },
      });
      await request("print-result", `${path}/result`, {
        method: "POST",
        token: runtime.agentTokens[index],
        body: { ...base, spoolerJobId: "synthetic-spool", status: "SUCCEEDED" },
      });
    }
    return response;
  }
  async function customer(kind = "paid") {
    await request("config", "/api/customer/config");
    if (kind === "browse") return;
    const draft = await request("draft", "/api/customer/drafts", {
      method: "POST",
      expected: [201],
      body: {
        customerName: "Synthetic Customer",
        customerPhone: "9000000000",
        instructions: null,
        originalFilename: "synthetic.pdf",
        expectedSizeBytes: pdf.length,
        sourcePageCount: 1,
      },
    });
    if (!draft.data) throw new Error("Draft fixture failed");
    const token = draft.data.draftToken;
    const key = decodeURIComponent(
      new URL(draft.data.upload.uploadUrl).pathname
        .split("/")
        .slice(2)
        .join("/"),
    );
    await runtime.env.PDF_BUCKET.put(key, pdf);
    await request("upload-complete", "/api/customer/uploads/complete", {
      method: "POST",
      token,
      body: draft.data.fileId ? { fileId: draft.data.fileId } : {},
    });
    const settings = {
      selectedPages: "1",
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    };
    const quote = await request("quote", "/api/customer/draft/print-settings", {
      method: "PUT",
      token,
      body: draft.data.fileId
        ? { files: [{ fileId: draft.data.fileId, ...settings }] }
        : settings,
    });
    if (kind === "abandon") return;
    if (!quote.data) throw new Error("Quote fixture failed");
    const checkout = await request(
      "payment-create",
      "/api/customer/payments/create",
      {
        method: "POST",
        token,
        body: { acknowledgedTotalPaise: quote.data.totalAmountPaise },
      },
    );
    if (!checkout.data?.razorpayOrderId)
      throw new Error("Checkout fixture failed");
    const orderId = checkout.data.razorpayOrderId;
    if (kind === "cancel") {
      await request("payment-cancel", "/api/customer/payments/cancel", {
        method: "POST",
        token,
        body: { razorpayOrderId: orderId },
      });
      return;
    }
    const paymentId = orderId.replace("order_", "pay_");
    const body = {
      trackingToken: randomBytes(32).toString("base64url"),
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: sign(
        `${orderId}|${paymentId}`,
        runtime.env.RAZORPAY_KEY_SECRET,
      ),
    };
    const verified = await request(
      "payment-verify",
      "/api/customer/payments/verify",
      { method: "POST", token, body },
    );
    if (!verified.data?.trackingToken)
      throw new Error("Verification fixture failed");
    await request(
      "tracking",
      "/api/customer/tracking/" + verified.data.jobCode,
      { token: verified.data.trackingToken },
    );
    return { token, body, verified: verified.data, orderId, paymentId };
  }
  async function abuse(index) {
    const options = [
      () => request("config", "/api/customer/config"),
      () =>
        request("invalid-tracking", "/api/customer/tracking/PG-ABC234", {
          token: "Z".repeat(43),
          expected: [404],
        }),
      () =>
        request("invalid-webhook", "/api/webhooks/razorpay", {
          method: "POST",
          body: { event: "payment.captured" },
          headers: { "x-razorpay-signature": "0".repeat(64) },
          expected: [400],
        }),
      () =>
        request("invalid-login", "/api/admin/auth/login", {
          method: "POST",
          admin: true,
          body: { loginIdentifier: "nobody", password: "wrong-password" },
          expected: [401],
        }),
      () =>
        request("invalid-pair", "/api/agent/pair", {
          method: "POST",
          body: { pairCode: "000000", displayName: "Synthetic" },
          expected: [400],
        }),
      () =>
        request("invalid-quote", "/api/customer/draft/print-settings", {
          method: "PUT",
          token: "Z".repeat(43),
          body: { copies: -1 },
          expected: [400],
        }),
    ];
    await options[index % options.length]();
  }
  return { customer, heartbeat, abuse, sign };
}
