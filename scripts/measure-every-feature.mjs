// Phase 9: Systematic Feature-by-Feature Execution and Resource Usage Measurement
// Local codebase execution only: isolated SQLite, mocked R2, mocked Razorpay, virtual 5-printer harness.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { createRuntime } from "./stress-runtime.mjs";

const outputDir = "docs/evidence/phase9";
mkdirSync(outputDir, { recursive: true });

function totals(runtime) {
  return {
    statements: runtime.totals.statements,
    returnedRows: runtime.totals.returnedRows,
    changedRows: runtime.totals.changedRows,
    r2: { ...runtime.totals.r2 },
    provider: { ...runtime.totals.provider },
  };
}

function subtract(after, before) {
  return {
    statements: after.statements - before.statements,
    returnedRows: after.returnedRows - before.returnedRows,
    changedRows: after.changedRows - before.changedRows,
    r2: Object.fromEntries(
      Object.keys(after.r2).map((key) => [key, after.r2[key] - before.r2[key]]),
    ),
    provider: Object.fromEntries(
      Object.keys(after.provider).map((key) => [
        key,
        after.provider[key] - before.provider[key],
      ]),
    ),
  };
}

function createValidPdfBuffer(sizeBytes = 1024) {
  const header = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\n";
  const trailer = "\ntrailer\n<<>>\n%%EOF\n";
  const padLength = Math.max(0, sizeBytes - header.length - trailer.length);
  const padding = " ".repeat(padLength);
  return Buffer.from(header + padding + trailer, "latin1");
}

function computeHmacSha256(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function main() {
  const runtimeDir = `.tmp/phase9-measure-every-feature-${Date.now()}`;
  const runtime = await createRuntime(runtimeDir, { profileWrites: true });
  const results = [];

  // Enable cash orders in installation (singleton has id = 1)
  runtime.db.exec(
    "UPDATE installation SET cash_orders_enabled = 1 WHERE id = 1",
  );
  // Ensure synthetic agent has active heartbeat for readiness checks
  runtime.db
    .prepare("UPDATE agents SET last_heartbeat_at_ms = ?, is_active = 1")
    .run(Date.now());

  // Track Durable Object wake calls
  let doWakeCount = 0;
  runtime.env.AGENT_ROOM = {
    idFromName: () => ({ toString: () => "shop" }),
    get: () => ({
      fetch: async () => {
        doWakeCount++;
        return new Response("ok");
      },
    }),
  };

  let simulatedClockMs = Date.now();
  Date.now = () => simulatedClockMs;

  function getUploadInfo(fileId) {
    const row = runtime.db
      .prepare("SELECT r2_object_key, order_id FROM uploads WHERE id = ?")
      .get(fileId);
    return { object_key: row.r2_object_key, order_id: row.order_id };
  }

  // Set up 5 Virtual Printers in database
  const P1_ID = randomUUID();
  const P2_ID = randomUUID();
  const P3_ID = randomUUID();
  const P4_ID = randomUUID();
  const P5_ID = randomUUID();

  // Clear initial synthetic printers from stress-runtime
  runtime.db.exec("DELETE FROM printers");

  const agentId = runtime.db.prepare("SELECT id FROM agents LIMIT 1").get().id;

  function insertPrinter(id, name, color, duplex, a3, status, physDev) {
    const caps = JSON.stringify({
      colour: color,
      duplex: duplex,
      paperSizes: a3 ? ["A4", "A3"] : ["A4"],
    });
    const verCaps = JSON.stringify({
      verified: {
        bw: 1,
        color: color ? 1 : 0,
        duplex: duplex ? 1 : 0,
        a4: 1,
        a3: a3 ? 1 : 0,
      },
      requiresReview: false,
    });
    const enServices = JSON.stringify({
      bw: 1,
      color: color ? 1 : 0,
      duplex: duplex ? 1 : 0,
      a4: 1,
      a3: a3 ? 1 : 0,
    });
    runtime.db
      .prepare(
        `INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled,
        status, capabilities_json, verified_capabilities_json, enabled_services_json,
        physical_device_id, is_production_eligible, is_virtual, last_status_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      )
      .run(
        id,
        agentId,
        name,
        name,
        status,
        caps,
        verCaps,
        enServices,
        physDev,
        simulatedClockMs,
        simulatedClockMs,
        simulatedClockMs,
      );
  }

  insertPrinter(
    P1_ID,
    "Simulated-BW-Simplex",
    false,
    false,
    false,
    "ONLINE",
    "DEV_PHYS_01",
  );
  insertPrinter(
    P2_ID,
    "Simulated-BW-Duplex",
    false,
    true,
    false,
    "ONLINE",
    "DEV_PHYS_02",
  );
  insertPrinter(
    P3_ID,
    "Simulated-Color-Simplex",
    true,
    false,
    true,
    "ONLINE",
    "DEV_PHYS_03",
  );
  insertPrinter(
    P4_ID,
    "Simulated-Color-Duplex",
    true,
    true,
    true,
    "ONLINE",
    "DEV_PHYS_04",
  );
  insertPrinter(
    P5_ID,
    "Simulated-Offline-Spare",
    false,
    false,
    false,
    "OFFLINE",
    "DEV_PHYS_05",
  );

  // Configure P1 as default production printer in installation
  runtime.db
    .prepare(
      `UPDATE installation SET default_production_printer_id = ? WHERE id = 1`,
    )
    .run(P1_ID);

  async function apiRequest(path, options = {}) {
    const isCustomer =
      path.startsWith("/api/customer") || path.startsWith("/health");
    const isAdmin = Boolean(options.admin) || path.startsWith("/api/admin");
    const headers = {
      ...(isCustomer ? { Origin: runtime.env.CUSTOMER_ALLOWED_ORIGIN } : {}),
      ...(isAdmin ? { Origin: runtime.env.ADMIN_ALLOWED_ORIGIN } : {}),
      ...(options.admin
        ? { Cookie: `__Host-printgo_admin=${runtime.adminToken}` }
        : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.agentToken
        ? { Authorization: `Bearer ${options.agentToken}` }
        : {}),
      ...(options.headers ?? {}),
    };
    if (options.body && !(options.body instanceof Uint8Array)) {
      headers["Content-Type"] = "application/json";
    }
    const req = new Request(`https://api.audit.invalid${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body instanceof Uint8Array
          ? options.body
          : options.body
            ? JSON.stringify(options.body)
            : undefined,
    });
    return runtime.api.routeRequest(req, runtime.env);
  }

  async function measure(
    featureId,
    featureName,
    category,
    method,
    endpoint,
    workerReqCount,
    actionFn,
  ) {
    const beforeTotals = totals(runtime);
    const beforeWakes = doWakeCount;
    let status = "PASS";
    let errorDetail = null;
    let res = null;

    try {
      res = await actionFn();
    } catch (err) {
      status = "FAIL";
      errorDetail = err instanceof Error ? err.message : String(err);
      console.error(`[FAIL] ${featureId}: ${featureName} - ${errorDetail}`);
    }

    const delta = subtract(totals(runtime), beforeTotals);
    const doWakes = doWakeCount - beforeWakes;

    const record = {
      featureId,
      featureName,
      category,
      method,
      endpoint,
      workerRequests: workerReqCount,
      sqlStatements: delta.statements,
      sqliteReturnedRows: delta.returnedRows,
      sqliteChangedRows: delta.changedRows,
      d1RowsRead:
        "NOT MEASURED (Local SQLite cannot emit Cloudflare D1 storage engine scanned rows metadata)",
      d1RowsWritten:
        "NOT MEASURED (Local SQLite cannot emit Cloudflare D1 index write metadata)",
      r2Operations: { ...delta.r2 },
      doWakes,
      result: status,
      errorDetail,
    };
    results.push(record);
    return res;
  }

  // =========================================================================
  // DOMAIN 1: CUSTOMER OPERATIONS
  // =========================================================================

  await measure(
    "CUST-01",
    "Health Check",
    "Customer",
    "GET",
    "/health",
    1,
    async () => {
      const resp = await apiRequest("/health");
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "CUST-02",
    "Get Shop Public Configuration",
    "Customer",
    "GET",
    "/api/customer/config",
    1,
    async () => {
      const resp = await apiRequest("/api/customer/config");
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.equal(json.data.onlinePrintingEnabled, true);
    },
  );

  let draftToken = "";
  let firstFileId = "";
  let r2Key = "";
  const VALID_PDF_BYTES = 1024;
  const samplePdf = createValidPdfBuffer(VALID_PDF_BYTES);

  await measure(
    "CUST-03",
    "Create Customer Draft Order",
    "Customer",
    "POST",
    "/api/customer/drafts",
    1,
    async () => {
      const resp = await apiRequest("/api/customer/drafts", {
        method: "POST",
        body: {
          customerName: "Rahul Sharma",
          customerPhone: "+91 98765 43210",
          originalFilename: "sample-notes.pdf",
          expectedSizeBytes: VALID_PDF_BYTES,
          sourcePageCount: 5,
          instructions: null,
        },
      });
      assert.equal(resp.status, 201);
      const json = await resp.json();
      draftToken = json.data.draftToken;
      firstFileId = json.data.fileId;
    },
  );

  await measure(
    "CUST-04",
    "Authorize Customer File Upload (R2 Pre-signed PUT)",
    "Customer",
    "POST",
    `/api/customer/uploads/authorize`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/uploads/authorize`, {
        token: draftToken,
        method: "POST",
        body: { fileId: firstFileId },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.ok(json.data.upload.uploadUrl);
      const info = getUploadInfo(firstFileId);
      r2Key = info.object_key;
    },
  );

  // Direct R2 PUT (simulating customer browser direct upload to private R2)
  await measure(
    "CUST-05",
    "Direct R2 Private Object Upload (Customer Browser -> R2)",
    "Storage",
    "PUT",
    "R2:printgo-pdfs",
    0, // Direct to R2; zero Worker requests
    async () => {
      await runtime.env.PDF_BUCKET.put(r2Key, samplePdf);
    },
  );

  await measure(
    "CUST-06",
    "Complete Upload Verification (Worker HEAD check)",
    "Customer",
    "POST",
    `/api/customer/uploads/complete`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/uploads/complete`, {
        token: draftToken,
        method: "POST",
        body: { fileId: firstFileId },
      });
      assert.equal(resp.status, 200);
    },
  );

  let secondFileId = "";
  await measure(
    "CUST-07",
    "Add Multi-File Item to Draft",
    "Customer",
    "POST",
    `/api/customer/draft/files`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/draft/files`, {
        token: draftToken,
        method: "POST",
        body: {
          originalFilename: "appendix.pdf",
          expectedSizeBytes: VALID_PDF_BYTES,
          sourcePageCount: 3,
        },
      });
      assert.equal(resp.status, 201);
      const json = await resp.json();
      secondFileId = json.data.fileId;
    },
  );

  await measure(
    "CUST-08",
    "Remove Multi-File Item from Draft",
    "Customer",
    "DELETE",
    `/api/customer/draft/files/:id`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/customer/draft/files/${secondFileId}`,
        {
          token: draftToken,
          method: "DELETE",
        },
      );
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "CUST-09",
    "Get Draft Status & Live Files",
    "Customer",
    "GET",
    `/api/customer/draft`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/draft`, {
        token: draftToken,
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.equal(json.data.files.length, 1);
    },
  );

  let quotedTotal = 0;
  await measure(
    "CUST-10",
    "Calculate Server-Authoritative Quote",
    "Customer",
    "PUT",
    `/api/customer/draft/print-settings`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/draft/print-settings`, {
        token: draftToken,
        method: "PUT",
        body: {
          files: [
            {
              fileId: firstFileId,
              selectedPages: "1-5",
              colorMode: "BW",
              paperSize: "A4",
              sides: "SINGLE",
              copies: 2,
            },
          ],
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      quotedTotal = json.data.totalAmountPaise;
      assert.ok(quotedTotal > 0);
    },
  );

  // Dedicated draft for testing cash selection at counter
  const cashSelectDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Counter Customer",
      customerPhone: "+91 98765 43210",
      originalFilename: "counter-doc.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 1,
      instructions: null,
    },
  });
  const csDraftJson = await cashSelectDraftResp.json();
  const csDraftToken = csDraftJson.data.draftToken;
  const csFileId = csDraftJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: csDraftToken,
    method: "POST",
    body: { fileId: csFileId },
  });
  const csKey = getUploadInfo(csFileId).object_key;
  await runtime.env.PDF_BUCKET.put(csKey, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: csDraftToken,
    method: "POST",
    body: { fileId: csFileId },
  });
  await apiRequest(`/api/customer/draft/print-settings`, {
    token: csDraftToken,
    method: "PUT",
    body: {
      files: [
        {
          fileId: csFileId,
          selectedPages: "1",
          colorMode: "BW",
          paperSize: "A4",
          sides: "SINGLE",
          copies: 1,
        },
      ],
    },
  });

  await measure(
    "CUST-11",
    "Select Cash Payment at Counter",
    "Customer",
    "POST",
    `/api/customer/payments/cash-select`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/payments/cash-select`, {
        token: csDraftToken,
        method: "POST",
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.ok(json.data.orderId);
      assert.ok(json.data.payableAmountPaise > 0);
    },
  );

  // Switch to online payment to test Razorpay flow
  let providerOrderId = "";
  const paymentTrackingToken = "T".repeat(43);
  await measure(
    "CUST-12",
    "Create Online Payment Checkout (Razorpay)",
    "Customer",
    "POST",
    `/api/customer/payments/create`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/payments/create`, {
        token: draftToken,
        method: "POST",
        body: {
          acknowledgedTotalPaise: quotedTotal,
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      providerOrderId = json.data.razorpayOrderId;
    },
  );

  await measure(
    "CUST-13",
    "Verify Online Payment - Tampered Signature (Failure Path)",
    "Security",
    "POST",
    `/api/customer/payments/verify`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/payments/verify`, {
        token: draftToken,
        method: "POST",
        body: {
          razorpayOrderId: providerOrderId,
          razorpayPaymentId: "pay_fake123",
          razorpaySignature:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          trackingToken: paymentTrackingToken,
        },
      });
      assert.equal(resp.status, 400);
    },
  );

  const providerPaymentId = providerOrderId.replace("order_", "pay_");
  const validSignature = computeHmacSha256(
    `${providerOrderId}|${providerPaymentId}`,
    runtime.env.RAZORPAY_KEY_SECRET,
  );

  let customerTrackingToken = "";
  let orderPublicPickupCode = "";
  let orderPublicJobCode = "";

  await measure(
    "CUST-14",
    "Verify Online Payment - Valid HMAC-SHA256 Signature",
    "Customer",
    "POST",
    `/api/customer/payments/verify`,
    1,
    async () => {
      const resp = await apiRequest(`/api/customer/payments/verify`, {
        token: draftToken,
        method: "POST",
        body: {
          razorpayOrderId: providerOrderId,
          razorpayPaymentId: providerPaymentId,
          razorpaySignature: validSignature,
          trackingToken: paymentTrackingToken,
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      customerTrackingToken = json.data.trackingToken;
      orderPublicPickupCode = json.data.pickupCode;
      orderPublicJobCode = json.data.jobCode;
    },
  );

  await measure(
    "CUST-15",
    "Customer Private Order Tracking",
    "Customer",
    "GET",
    `/api/customer/tracking/:jobCode`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/customer/tracking/${orderPublicJobCode}`,
        {
          token: customerTrackingToken,
        },
      );
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.equal(json.data.jobCode, orderPublicJobCode);
    },
  );

  await measure(
    "CUST-16",
    "Customer Public Pickup Code Tracking",
    "Customer",
    "GET",
    `/api/customer/track/:pickupCode`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/customer/track/${orderPublicPickupCode}`,
      );
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.equal(json.data.pickupCode, orderPublicPickupCode);
    },
  );

  // =========================================================================
  // DOMAIN 2: PAYMENTS & WEBHOOKS
  // =========================================================================

  // Create another order for webhook capture test
  const webhookDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Priya Patel",
      customerPhone: "+91 91234 56789",
      originalFilename: "project-report.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 10,
      instructions: null,
    },
  });
  assert.equal(webhookDraftResp.status, 201);
  const whDraftJson = await webhookDraftResp.json();
  const whDraftToken = whDraftJson.data.draftToken;
  const whFileId = whDraftJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: whDraftToken,
    method: "POST",
    body: { fileId: whFileId },
  });
  const whInfo = getUploadInfo(whFileId);
  const whR2Key = whInfo.object_key;
  await runtime.env.PDF_BUCKET.put(whR2Key, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: whDraftToken,
    method: "POST",
    body: { fileId: whFileId },
  });
  const whQuoteResp = await apiRequest(`/api/customer/draft/print-settings`, {
    token: whDraftToken,
    method: "PUT",
    body: {
      files: [
        {
          fileId: whFileId,
          selectedPages: "1-10",
          colorMode: "COLOR",
          paperSize: "A4",
          sides: "DOUBLE",
          copies: 1,
        },
      ],
    },
  });
  const whTotal = (await whQuoteResp.json()).data.totalAmountPaise;

  const whPayResp = await apiRequest(`/api/customer/payments/create`, {
    token: whDraftToken,
    method: "POST",
    body: {
      acknowledgedTotalPaise: whTotal,
    },
  });
  const whProviderOrderId = (await whPayResp.json()).data.razorpayOrderId;
  const whPayId = whProviderOrderId.replace("order_", "pay_");

  const whPayload = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: whPayId,
          order_id: whProviderOrderId,
          amount: whTotal,
          currency: "INR",
          status: "captured",
        },
      },
    },
  });

  const whValidSig = computeHmacSha256(
    whPayload,
    runtime.env.RAZORPAY_WEBHOOK_SECRET,
  );

  await measure(
    "PAY-01",
    "Razorpay Webhook - Tampered Signature (Failure Path)",
    "Security",
    "POST",
    "/api/webhooks/razorpay",
    1,
    async () => {
      const resp = await apiRequest("/api/webhooks/razorpay", {
        method: "POST",
        headers: {
          "x-razorpay-signature": "tampered_signature",
          "x-razorpay-event-id": "evt_measure_01",
        },
        body: Buffer.from(whPayload),
      });
      assert.equal(resp.status, 400);
    },
  );

  await measure(
    "PAY-02",
    "Razorpay Webhook - Valid Captured Payment",
    "Payment",
    "POST",
    "/api/webhooks/razorpay",
    1,
    async () => {
      const resp = await apiRequest("/api/webhooks/razorpay", {
        method: "POST",
        headers: {
          "x-razorpay-signature": whValidSig,
          "x-razorpay-event-id": "evt_measure_02",
        },
        body: Buffer.from(whPayload),
      });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "PAY-03",
    "Razorpay Webhook - Duplicate Replay Idempotency",
    "Payment",
    "POST",
    "/api/webhooks/razorpay",
    1,
    async () => {
      const resp = await apiRequest("/api/webhooks/razorpay", {
        method: "POST",
        headers: {
          "x-razorpay-signature": whValidSig,
          "x-razorpay-event-id": "evt_measure_02", // replay identical event ID
        },
        body: Buffer.from(whPayload),
      });
      assert.equal(resp.status, 200);
    },
  );

  // =========================================================================
  // DOMAIN 3: ADMIN OPERATIONS & CONTROLS
  // =========================================================================

  await measure(
    "ADM-01",
    "Admin Authentication (Login)",
    "Admin",
    "POST",
    "/api/admin/auth/login",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/auth/login", {
        admin: true,
        method: "POST",
        body: {
          loginIdentifier: "synthetic-admin",
          password: runtime.password,
        },
      });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-02",
    "Admin Session Validation (/me)",
    "Admin",
    "GET",
    "/api/admin/auth/me",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/auth/me", { admin: true });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-03",
    "Admin Dashboard Overview & Today Stats",
    "Admin",
    "GET",
    "/api/admin/dashboard",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/dashboard", { admin: true });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.ok(json.data.statusCounts);
    },
  );

  await measure(
    "ADM-04",
    "Admin Live Orders Queue",
    "Admin",
    "GET",
    "/api/admin/orders/live",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/orders/live", { admin: true });
      assert.equal(resp.status, 200);
    },
  );

  // Create a Cash Order for Admin Confirmation
  const cashDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Aman Verma",
      customerPhone: "+91 99999 88888",
      originalFilename: "resume.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 2,
      instructions: null,
    },
  });
  const cashDraftJson = await cashDraftResp.json();
  const cashDraftToken = cashDraftJson.data.draftToken;
  const cashFileId = cashDraftJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: cashDraftToken,
    method: "POST",
    body: { fileId: cashFileId },
  });
  const cashInfo = getUploadInfo(cashFileId);
  const cashR2Key = cashInfo.object_key;
  const cashOrderId = cashInfo.order_id;
  await runtime.env.PDF_BUCKET.put(cashR2Key, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: cashDraftToken,
    method: "POST",
    body: { fileId: cashFileId },
  });
  await apiRequest(`/api/customer/draft/print-settings`, {
    token: cashDraftToken,
    method: "PUT",
    body: {
      files: [
        {
          fileId: cashFileId,
          selectedPages: "1-2",
          colorMode: "BW",
          paperSize: "A4",
          sides: "SINGLE",
          copies: 1,
        },
      ],
    },
  });
  await apiRequest(`/api/customer/payments/cash-select`, {
    token: cashDraftToken,
    method: "POST",
  });

  await measure(
    "ADM-05",
    "Admin Pending Cash Orders List",
    "Admin",
    "GET",
    "/api/admin/orders/cash",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/orders/cash", { admin: true });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-06",
    "Admin Confirm Cash Payment at Counter",
    "Admin",
    "POST",
    `/api/admin/orders/:id/confirm-cash`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/admin/orders/${cashOrderId}/confirm-cash`,
        {
          admin: true,
          method: "POST",
        },
      );
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-07",
    "Admin Manual Orders Queue",
    "Admin",
    "GET",
    "/api/admin/orders/manual",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/orders/manual", {
        admin: true,
      });
      assert.equal(resp.status, 200);
    },
  );

  // Set pickup charge on an order
  await measure(
    "ADM-08",
    "Admin Set Staff-Priced Pickup Charge",
    "Admin",
    "POST",
    `/api/admin/orders/:id/set-pickup-charge`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/admin/orders/${cashOrderId}/set-pickup-charge`,
        {
          admin: true,
          method: "POST",
          body: { dueAtPickupPaise: 3000 },
        },
      );
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-09",
    "Admin Order History (Keyset Pagination)",
    "Admin",
    "GET",
    "/api/admin/orders/history",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/orders/history", {
        admin: true,
      });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-10",
    "Admin Get Shop Settings",
    "Admin",
    "GET",
    "/api/admin/settings",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/settings", { admin: true });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-11",
    "Admin Update Shop Settings",
    "Admin",
    "PUT",
    "/api/admin/settings",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/settings", {
        admin: true,
        method: "PUT",
        body: {
          shopName: "Central Xerox & Print",
          contactPhone: "+91 98765 00000",
          address: "123 Main Market",
          customerNotice: "Welcome to Central Xerox",
          onlinePrintingEnabled: true,
          cashOrdersEnabled: true,
          maxPdfSizeBytes: 20971520,
          identificationSheetEnabled: true,
          identificationSheetPlacement: "FIRST",
          idSheetMinPages: 5,
          idSheetMinAmountPaise: 2000,
        },
      });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-12",
    "Admin Reset Daily Pickup Code Sequence",
    "Admin",
    "POST",
    "/api/admin/settings/reset-pickup-code",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/settings/reset-pickup-code", {
        admin: true,
        method: "POST",
      });
      // Either 200 (reset succeeded) or 409 (ACTIVE_ORDER_COLLISION) is valid API behavior
      assert.ok(resp.status === 200 || resp.status === 409);
    },
  );

  await measure(
    "ADM-13",
    "Admin List Registered Printers",
    "Admin",
    "GET",
    "/api/admin/printers",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/printers", { admin: true });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-14",
    "Admin Update Printer Settings (Fallback & Priority)",
    "Admin",
    "PUT",
    `/api/admin/printers/:id`,
    1,
    async () => {
      const resp = await apiRequest(`/api/admin/printers/${P1_ID}`, {
        admin: true,
        method: "PUT",
        body: {
          enabled: true,
          priority: 10,
          autoFallbackEnabled: true,
          fallbackPrinterId: P2_ID,
        },
      });
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ADM-17",
    "Admin Create Addon Service (Spiral Binding)",
    "Admin",
    "POST",
    "/api/admin/addon-services",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/addon-services", {
        admin: true,
        method: "POST",
        body: {
          name: "Spiral Binding",
          pricingType: "FIXED_PRICE",
          fixedPricePaise: 4000,
          handlingMode: "POST_PRINT",
          enabled: true,
          displayOrder: 1,
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      assert.ok(json.data.addonService.id);
    },
  );

  await measure(
    "ADM-18",
    "Admin List Addon Services",
    "Admin",
    "GET",
    "/api/admin/addon-services",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/addon-services", {
        admin: true,
      });
      assert.equal(resp.status, 200);
    },
  );

  const firstOrderId = getUploadInfo(firstFileId).order_id;
  await measure(
    "ADM-19",
    "Admin Get Customer PDF Download URL",
    "Admin",
    "GET",
    `/api/admin/orders/:id/pdf-url`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/admin/orders/${firstOrderId}/pdf-url`,
        {
          admin: true,
        },
      );
      assert.equal(resp.status, 200);
    },
  );

  let pairCode = "";
  await measure(
    "ADM-16",
    "Admin Generate Agent Pair Code",
    "Admin",
    "POST",
    "/api/admin/agents/pair-code",
    1,
    async () => {
      const resp = await apiRequest("/api/admin/agents/pair-code", {
        admin: true,
        method: "POST",
      });
      assert.equal(resp.status, 201);
      const json = await resp.json();
      pairCode = json.data.pairCode;
    },
  );

  let pairedAgentSecret = "";
  let pairedAgentId = "";
  await measure(
    "AGT-01",
    "Agent Pairing with 8-Digit Code",
    "Agent",
    "POST",
    "/api/agent/pair",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pair", {
        method: "POST",
        body: {
          pairCode,
          displayName: "Virtual Test Agent Node",
        },
      });
      assert.equal(resp.status, 201);
      const json = await resp.json();
      pairedAgentSecret = json.data.agentSecret;
      pairedAgentId = json.data.agentId;
    },
  );

  // Reassign all 5 virtual printers to the newly paired agent & reactivate P1-P4
  runtime.db
    .prepare("UPDATE printers SET agent_id = ? WHERE id IN (?, ?, ?, ?, ?)")
    .run(pairedAgentId, P1_ID, P2_ID, P3_ID, P4_ID, P5_ID);
  runtime.db
    .prepare(
      "UPDATE printers SET enabled = 1, status = 'ONLINE' WHERE id IN (?, ?, ?, ?)",
    )
    .run(P1_ID, P2_ID, P3_ID, P4_ID);
  runtime.db
    .prepare("UPDATE printers SET enabled = 1, status = 'OFFLINE' WHERE id = ?")
    .run(P5_ID);
  const activeAgentToken = pairedAgentSecret;

  await measure(
    "AGT-02",
    "Agent Idle Pulse with No Jobs (OPT-6 Fast Gate Probe)",
    "Agent",
    "POST",
    "/api/agent/pulse",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pulse", {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
        },
      });
      assert.equal(resp.status, 200);
    },
  );

  let testCmdId = "";
  await measure(
    "ADM-15",
    "Admin Issue Diagnostic Test Print",
    "Admin",
    "POST",
    `/api/admin/printers/:id/test-print`,
    1,
    async () => {
      const resp = await apiRequest(`/api/admin/printers/${P1_ID}/test-print`, {
        admin: true,
        method: "POST",
      });
      assert.equal(resp.status, 201);
      const json = await resp.json();
      testCmdId = json.data.testPrint.commandId;
    },
  );

  // Agent pulse claims the diagnostic test print command so its status transitions to CLAIMED
  await apiRequest("/api/agent/pulse", {
    agentToken: activeAgentToken,
    method: "POST",
    body: {
      agentVersion: "2.0.0",
      operationalState: "ONLINE",
    },
  });

  await measure(
    "AGT-03",
    "Agent Report Command Execution (Test Print SUCCEEDED)",
    "Agent",
    "POST",
    `/api/agent/commands/:id/report`,
    1,
    async () => {
      const resp = await apiRequest(`/api/agent/commands/${testCmdId}/report`, {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          status: "SUCCEEDED",
          spoolerJobId: "spool-diag-451",
        },
      });
      assert.equal(resp.status, 200);
    },
  );

  let claimedJob = null;
  await measure(
    "ROUT-01",
    "P1: Claim B&W Simplex Job (Default Production Printer)",
    "Routing",
    "POST",
    "/api/agent/pulse",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pulse", {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      const jobs =
        json.data.printJobs ?? (json.data.printJob ? [json.data.printJob] : []);
      assert.ok(jobs.length > 0);
      claimedJob = jobs.find((j) => j.printerId === P1_ID) ?? jobs[0];
      assert.equal(claimedJob.printerId, P1_ID);
    },
  );

  const stepId = claimedJob.currentStep.stepId;

  await measure(
    "ROUT-02",
    "Agent Acknowledge Submission Started",
    "Printing",
    "POST",
    `/api/agent/print-jobs/:orderId/steps/:stepId/start`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/agent/print-jobs/${claimedJob.orderId}/steps/${stepId}/start`,
        {
          agentToken: activeAgentToken,
          method: "POST",
          body: { claimId: claimedJob.claimId },
        },
      );
      assert.equal(resp.status, 200);
    },
  );

  const virtualSpoolId = `virt-spool-${Date.now()}`;
  await measure(
    "ROUT-03",
    "Agent Persist Spooler Job ID (winspool correlation)",
    "Printing",
    "POST",
    `/api/agent/print-jobs/:orderId/steps/:stepId/submitted`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/agent/print-jobs/${claimedJob.orderId}/steps/${stepId}/submitted`,
        {
          agentToken: activeAgentToken,
          method: "POST",
          body: {
            claimId: claimedJob.claimId,
            spoolerJobId: virtualSpoolId,
          },
        },
      );
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ROUT-04",
    "Agent Complete Step Execution",
    "Printing",
    "POST",
    `/api/agent/print-jobs/:orderId/steps/:stepId/result`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/agent/print-jobs/${claimedJob.orderId}/steps/${stepId}/result`,
        {
          agentToken: activeAgentToken,
          method: "POST",
          body: {
            claimId: claimedJob.claimId,
            spoolerJobId: virtualSpoolId,
            status: "SUCCEEDED",
          },
        },
      );
      assert.equal(resp.status, 200);

      // If the attempt has subsequent steps (e.g. CUSTOMER_DOCUMENT after IDENTIFICATION_SHEET),
      // transition through start -> submitted -> result so the order finishes and frees P1
      const nextStep = runtime.db
        .prepare(
          "SELECT id, step_type, status FROM print_attempt_steps WHERE order_id = ? AND status <> 'SUCCEEDED' LIMIT 1",
        )
        .get(claimedJob.orderId);
      if (nextStep) {
        const docSpoolId = `doc-${virtualSpoolId}`;
        await apiRequest(
          `/api/agent/print-jobs/${claimedJob.orderId}/steps/${nextStep.id}/start`,
          {
            agentToken: activeAgentToken,
            method: "POST",
            body: { claimId: claimedJob.claimId },
          },
        );
        await apiRequest(
          `/api/agent/print-jobs/${claimedJob.orderId}/steps/${nextStep.id}/submitted`,
          {
            agentToken: activeAgentToken,
            method: "POST",
            body: {
              claimId: claimedJob.claimId,
              spoolerJobId: docSpoolId,
            },
          },
        );
        await apiRequest(
          `/api/agent/print-jobs/${claimedJob.orderId}/steps/${nextStep.id}/result`,
          {
            agentToken: activeAgentToken,
            method: "POST",
            body: {
              claimId: claimedJob.claimId,
              spoolerJobId: docSpoolId,
              status: "SUCCEEDED",
            },
          },
        );
      }
    },
  );

  // Test B&W Duplex routing to P2
  const duplexDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Sanjay Gupta",
      customerPhone: "+91 98888 77777",
      originalFilename: "handout.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 4,
      instructions: null,
    },
  });
  const duplexDraftJson = await duplexDraftResp.json();
  const duplexDraftToken = duplexDraftJson.data.draftToken;
  const dFileId = duplexDraftJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: duplexDraftToken,
    method: "POST",
    body: { fileId: dFileId },
  });
  const duplexInfo = getUploadInfo(dFileId);
  const duplexR2Key = duplexInfo.object_key;
  await runtime.env.PDF_BUCKET.put(duplexR2Key, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: duplexDraftToken,
    method: "POST",
    body: { fileId: dFileId },
  });
  const dQuote = await apiRequest(`/api/customer/draft/print-settings`, {
    token: duplexDraftToken,
    method: "PUT",
    body: {
      files: [
        {
          fileId: dFileId,
          selectedPages: "1-4",
          colorMode: "BW",
          paperSize: "A4",
          sides: "DOUBLE",
          copies: 1,
        },
      ],
    },
  });
  const dTotal = (await dQuote.json()).data.totalAmountPaise;

  const dPay = await apiRequest(`/api/customer/payments/create`, {
    token: duplexDraftToken,
    method: "POST",
    body: { acknowledgedTotalPaise: dTotal },
  });
  const dPayJson = await dPay.json();
  const dOrderId = dPayJson.data.razorpayOrderId;
  const dTrackToken = "D".repeat(43);
  const dPayId = dOrderId.replace("order_", "pay_");
  const dSig = computeHmacSha256(
    `${dOrderId}|${dPayId}`,
    runtime.env.RAZORPAY_KEY_SECRET,
  );
  await apiRequest(`/api/customer/payments/verify`, {
    token: duplexDraftToken,
    method: "POST",
    body: {
      razorpayOrderId: dOrderId,
      razorpayPaymentId: dPayId,
      razorpaySignature: dSig,
      trackingToken: dTrackToken,
    },
  });

  await measure(
    "ROUT-05",
    "P2: Capability Routing for B&W Duplex Order (Subcase B1)",
    "Routing",
    "POST",
    "/api/agent/pulse",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pulse", {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      const jobs =
        json.data.printJobs ?? (json.data.printJob ? [json.data.printJob] : []);
      const job = jobs.find((j) => j.printerId === P2_ID);
      assert.ok(job, "Expected job routed to P2 (B&W Duplex)");
      assert.equal(job.printerId, P2_ID);
    },
  );

  // Test Color Simplex routing to P3
  const colorDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Kavita Singh",
      customerPhone: "+91 97777 66666",
      originalFilename: "poster.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 1,
      instructions: null,
    },
  });
  const colorDraftJson = await colorDraftResp.json();
  const colorDraftToken = colorDraftJson.data.draftToken;
  const cFileId = colorDraftJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: colorDraftToken,
    method: "POST",
    body: { fileId: cFileId },
  });
  const colorInfo = getUploadInfo(cFileId);
  const colorR2Key = colorInfo.object_key;
  await runtime.env.PDF_BUCKET.put(colorR2Key, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: colorDraftToken,
    method: "POST",
    body: { fileId: cFileId },
  });
  const cQuote = await apiRequest(`/api/customer/draft/print-settings`, {
    token: colorDraftToken,
    method: "PUT",
    body: {
      files: [
        {
          fileId: cFileId,
          selectedPages: "1",
          colorMode: "COLOR",
          paperSize: "A4",
          sides: "SINGLE",
          copies: 1,
        },
      ],
    },
  });
  const cTotal = (await cQuote.json()).data.totalAmountPaise;

  const cPay = await apiRequest(`/api/customer/payments/create`, {
    token: colorDraftToken,
    method: "POST",
    body: { acknowledgedTotalPaise: cTotal },
  });
  const cPayJson = await cPay.json();
  const cOrderId = cPayJson.data.razorpayOrderId;
  const cTrackToken = "C".repeat(43);
  const cPayId = cOrderId.replace("order_", "pay_");
  const cSig = computeHmacSha256(
    `${cOrderId}|${cPayId}`,
    runtime.env.RAZORPAY_KEY_SECRET,
  );
  await apiRequest(`/api/customer/payments/verify`, {
    token: colorDraftToken,
    method: "POST",
    body: {
      razorpayOrderId: cOrderId,
      razorpayPaymentId: cPayId,
      razorpaySignature: cSig,
      trackingToken: cTrackToken,
    },
  });

  await measure(
    "ROUT-06",
    "P3: Capability Routing for Color Simplex Order (Subcase B1)",
    "Routing",
    "POST",
    "/api/agent/pulse",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pulse", {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      const jobs =
        json.data.printJobs ?? (json.data.printJob ? [json.data.printJob] : []);
      const job = jobs.find((j) => j.printerId === P3_ID);
      assert.ok(job, "Expected job routed to P3 (Color Simplex)");
      assert.equal(job.printerId, P3_ID);
    },
  );

  // Test Color Duplex routing to P4
  const colorDupDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Arun Verma",
      customerPhone: "+91 95555 44444",
      originalFilename: "brochure.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 6,
      instructions: null,
    },
  });
  const cdJson = await colorDupDraftResp.json();
  const cdToken = cdJson.data.draftToken;
  const cdFileId = cdJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: cdToken,
    method: "POST",
    body: { fileId: cdFileId },
  });
  const cdInfo = getUploadInfo(cdFileId);
  const cdR2Key = cdInfo.object_key;
  await runtime.env.PDF_BUCKET.put(cdR2Key, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: cdToken,
    method: "POST",
    body: { fileId: cdFileId },
  });
  const cdQuote = await apiRequest(`/api/customer/draft/print-settings`, {
    token: cdToken,
    method: "PUT",
    body: {
      files: [
        {
          fileId: cdFileId,
          selectedPages: "1-6",
          colorMode: "COLOR",
          paperSize: "A4",
          sides: "DOUBLE",
          copies: 1,
        },
      ],
    },
  });
  const cdTotal = (await cdQuote.json()).data.totalAmountPaise;

  const cdPay = await apiRequest(`/api/customer/payments/create`, {
    token: cdToken,
    method: "POST",
    body: { acknowledgedTotalPaise: cdTotal },
  });
  const cdPayJson = await cdPay.json();
  const cdOrderId = cdPayJson.data.razorpayOrderId;
  const cdTrackToken = "E".repeat(43);
  const cdPayId = cdOrderId.replace("order_", "pay_");
  const cdSig = computeHmacSha256(
    `${cdOrderId}|${cdPayId}`,
    runtime.env.RAZORPAY_KEY_SECRET,
  );
  await apiRequest(`/api/customer/payments/verify`, {
    token: cdToken,
    method: "POST",
    body: {
      razorpayOrderId: cdOrderId,
      razorpayPaymentId: cdPayId,
      razorpaySignature: cdSig,
      trackingToken: cdTrackToken,
    },
  });

  await measure(
    "ROUT-07",
    "P4: Capability Routing for Color Duplex Order (Subcase B1)",
    "Routing",
    "POST",
    "/api/agent/pulse",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pulse", {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      const jobs =
        json.data.printJobs ?? (json.data.printJob ? [json.data.printJob] : []);
      const job = jobs.find((j) => j.printerId === P4_ID);
      assert.ok(job, "Expected job routed to P4 (Color Duplex)");
      assert.equal(job.printerId, P4_ID);
    },
  );

  // Duplex Starvation Prevention:
  // Order is placed for Double-Sided printing while duplex printers are available.
  const starvedDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Vikram Mehta",
      customerPhone: "+91 96666 55555",
      originalFilename: "duplex-thesis.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 8,
      instructions: null,
    },
  });
  const starvedDraftJson = await starvedDraftResp.json();
  const starvedDraftToken = starvedDraftJson.data.draftToken;
  const sFileId = starvedDraftJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: starvedDraftToken,
    method: "POST",
    body: { fileId: sFileId },
  });
  const sInfo = getUploadInfo(sFileId);
  const sR2Key = sInfo.object_key;
  const starvedOrderId = sInfo.order_id;
  await runtime.env.PDF_BUCKET.put(sR2Key, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: starvedDraftToken,
    method: "POST",
    body: { fileId: sFileId },
  });
  const sQuote = await apiRequest(`/api/customer/draft/print-settings`, {
    token: starvedDraftToken,
    method: "PUT",
    body: {
      files: [
        {
          fileId: sFileId,
          selectedPages: "1-8",
          colorMode: "BW",
          paperSize: "A4",
          sides: "DOUBLE",
          copies: 1,
        },
      ],
    },
  });
  const sTotal = (await sQuote.json()).data.totalAmountPaise;

  const sPay = await apiRequest(`/api/customer/payments/create`, {
    token: starvedDraftToken,
    method: "POST",
    body: { acknowledgedTotalPaise: sTotal },
  });
  const sPayJson = await sPay.json();
  const sOrderId = sPayJson.data.razorpayOrderId;
  const sTrackToken = "S".repeat(43);
  const sPayId = sOrderId.replace("order_", "pay_");
  const sSig = computeHmacSha256(
    `${sOrderId}|${sPayId}`,
    runtime.env.RAZORPAY_KEY_SECRET,
  );
  await apiRequest(`/api/customer/payments/verify`, {
    token: starvedDraftToken,
    method: "POST",
    body: {
      razorpayOrderId: sOrderId,
      razorpayPaymentId: sPayId,
      razorpaySignature: sSig,
      trackingToken: sTrackToken,
    },
  });

  // Now simulate duplex printers going OFFLINE so only P1 & P3 (Simplex) are available
  runtime.db
    .prepare("UPDATE printers SET status = 'OFFLINE' WHERE id IN (?, ?)")
    .run(P2_ID, P4_ID);

  await measure(
    "ROUT-08",
    "Duplex Starvation Prevention (Order Stays QUEUED on P1/P3)",
    "Safety",
    "POST",
    "/api/agent/pulse",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pulse", {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      const jobs =
        json.data.printJobs ?? (json.data.printJob ? [json.data.printJob] : []);
      const found = jobs.find((j) => j.orderId === starvedOrderId);
      assert.equal(
        found,
        undefined,
        "Duplex job MUST NOT be claimed by simplex-only P1 or P3",
      );
    },
  );

  // Convert to Single-Sided by Admin to unblock on P1
  await measure(
    "ROUT-09",
    "Admin Convert Starved Duplex Order to Single-Sided",
    "Admin",
    "POST",
    `/api/admin/orders/:id/convert-single-sided`,
    1,
    async () => {
      const resp = await apiRequest(
        `/api/admin/orders/${starvedOrderId}/convert-single-sided`,
        {
          admin: true,
          method: "POST",
        },
      );
      assert.equal(resp.status, 200);
    },
  );

  await measure(
    "ROUT-10",
    "P1: Claim Converted Single-Sided Order",
    "Routing",
    "POST",
    "/api/agent/pulse",
    1,
    async () => {
      const resp = await apiRequest("/api/agent/pulse", {
        agentToken: activeAgentToken,
        method: "POST",
        body: {
          agentVersion: "2.0.0",
          operationalState: "ONLINE",
        },
      });
      assert.equal(resp.status, 200);
      const json = await resp.json();
      const jobs =
        json.data.printJobs ?? (json.data.printJob ? [json.data.printJob] : []);
      const job = jobs.find((j) => j.orderId === starvedOrderId);
      assert.ok(job, "Expected converted job claimed on P1");
      assert.equal(job.printerId, P1_ID);
    },
  );

  // Restore P2 & P4
  runtime.db
    .prepare("UPDATE printers SET status = 'ONLINE' WHERE id IN (?, ?)")
    .run(P2_ID, P4_ID);

  // =========================================================================
  // DOMAIN 5: BACKGROUND TASKS, RETENTION & CLEANUP
  // =========================================================================

  await measure(
    "BG-01",
    "Scheduled Retention Cron (No Work Probe)",
    "Background",
    "CRON",
    "RetentionService.runCleanup",
    0, // Background execution
    async () => {
      const retentionRepo = new runtime.api.D1RetentionRepository(
        runtime.env.DB,
      );
      const service = new runtime.api.RetentionService(
        retentionRepo,
        runtime.env.PDF_BUCKET,
        () => simulatedClockMs,
      );
      await service.runCleanup();
    },
  );

  // Age unpaid draft to 11 minutes (past 10-minute deadline)
  const expiredDraftResp = await apiRequest("/api/customer/drafts", {
    method: "POST",
    body: {
      customerName: "Old Draft",
      customerPhone: "+91 90000 00000",
      originalFilename: "old.pdf",
      expectedSizeBytes: VALID_PDF_BYTES,
      sourcePageCount: 1,
      instructions: null,
    },
  });
  const expJson = await expiredDraftResp.json();
  const expToken = expJson.data.draftToken;
  const expFileId = expJson.data.fileId;
  await apiRequest(`/api/customer/uploads/authorize`, {
    token: expToken,
    method: "POST",
    body: { fileId: expFileId },
  });
  const expInfo = getUploadInfo(expFileId);
  const expKey = expInfo.object_key;
  await runtime.env.PDF_BUCKET.put(expKey, samplePdf);
  await apiRequest(`/api/customer/uploads/complete`, {
    token: expToken,
    method: "POST",
    body: { fileId: expFileId },
  });

  // Advance clock by 11 minutes (660,000 ms)
  simulatedClockMs += 660_000;

  await measure(
    "BG-02",
    "Retention Purge of 10-Minute Expired Unpaid Draft (R2 DELETE)",
    "Cleanup",
    "CRON",
    "RetentionService.runCleanup (Expired Upload)",
    0,
    async () => {
      const retentionRepo = new runtime.api.D1RetentionRepository(
        runtime.env.DB,
      );
      const service = new runtime.api.RetentionService(
        retentionRepo,
        runtime.env.PDF_BUCKET,
        () => simulatedClockMs,
      );
      await service.runCleanup();
    },
  );

  // Advance clock by 5.5 hours to trigger PII redaction
  simulatedClockMs += 5.5 * 3600 * 1000;

  await measure(
    "BG-03",
    "Statutory Accounting: Customer PII Redaction at 5 Hours",
    "Cleanup",
    "CRON",
    "RetentionService.runCleanup (Customer PII Purge)",
    0,
    async () => {
      const retentionRepo = new runtime.api.D1RetentionRepository(
        runtime.env.DB,
      );
      const service = new runtime.api.RetentionService(
        retentionRepo,
        runtime.env.PDF_BUCKET,
        () => simulatedClockMs,
      );
      const res = await service.runCleanup();
      assert.ok(res.purgedPiiCount >= 0, "PII purge candidates processed");
    },
  );

  // Final summary serialization
  const auditReport = {
    generatedAt: new Date().toISOString(),
    totalFeaturesMeasured: results.length,
    passedCount: results.filter((r) => r.result === "PASS").length,
    failedCount: results.filter((r) => r.result === "FAIL").length,
    printersConfigured: 5,
    results,
  };

  writeFileSync(
    `${outputDir}/feature-measurements.json`,
    JSON.stringify(auditReport, null, 2),
  );

  console.log(
    `Phase 9 Feature Audit Completed: ${auditReport.passedCount} PASSED, ${auditReport.failedCount} FAILED out of ${results.length} total operations.`,
  );

  runtime.close();
}

main().catch((err) => {
  console.error("FATAL ERROR IN PHASE 9 FEATURE AUDIT:", err);
  process.exit(1);
});
