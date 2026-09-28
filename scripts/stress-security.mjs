#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { createRuntime } from "./stress-runtime.mjs";
import { Histogram } from "./stress-metrics.mjs";
const dir = `.tmp/stress/security-${Date.now()}`;
const runtime = await createRuntime(dir);
const { build } =
  await import("../apps/agent/windows/node_modules/esbuild/lib/main.js");
const extra = resolve(dir, "extra.mjs");
await build({
  stdin: {
    contents: `export {verifyPdfObject} from './apps/api/worker/src/storage/r2-verification.ts'; export {downloadAndValidateCustomerPdf} from './apps/agent/windows/src/printing/customer-pdf.ts'; export {validateAndNormalizePrintSettings} from './apps/agent/windows/src/printing/print-settings.ts';`,
    resolveDir: process.cwd(),
  },
  outfile: extra,
  bundle: true,
  platform: "node",
  format: "esm",
  alias: Object.fromEntries(
    ["domain", "shared"].map((x) => [
      `@printgo/${x}`,
      resolve(`packages/${x}/src/index.ts`),
    ]),
  ),
});
const {
  verifyPdfObject,
  downloadAndValidateCustomerPdf,
  validateAndNormalizePrintSettings,
} = await import(extra);
const results = [],
  latencies = new Map();
const signature = (text, key) =>
  createHmac("sha256", key).update(text).digest("hex");
async function request(
  path,
  {
    method = "GET",
    body,
    token,
    admin = false,
    origin,
    headers = {},
    raw,
  } = {},
) {
  const start = performance.now();
  const r = await runtime.api.routeRequest(
    new Request("https://api.audit.invalid" + path, {
      method,
      headers: {
        Origin:
          origin ??
          (admin
            ? runtime.env.ADMIN_ALLOWED_ORIGIN
            : runtime.env.CUSTOMER_ALLOWED_ORIGIN),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(admin
          ? { Cookie: `__Host-printgo_admin=${runtime.adminToken}` }
          : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(raw !== undefined
        ? { body: raw }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
    }),
    runtime.env,
  );
  const metricPath = path.startsWith("/api/customer/tracking/")
    ? "/api/customer/tracking/:jobCode"
    : path;
  const h = latencies.get(metricPath) ?? new Histogram();
  h.add(performance.now() - start);
  latencies.set(metricPath, h);
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function check(name, fn) {
  try {
    const evidence = await fn();
    results.push({ name, status: "PASS", evidence: evidence ?? null });
  } catch (e) {
    results.push({ name, status: "FAIL", error: e.message.slice(0, 180) });
  }
}
function makePdf(pages = 1, extraObject = "") {
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    `<</Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}]>>`,
    ...Array.from(
      { length: pages },
      () => "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100]>>",
    ),
  ];
  if (extraObject) objects.push(extraObject);
  let text = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = Buffer.byteLength(text);
  text +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
const tiny = makePdf();
const draftInput = {
  customerName: "Synthetic Customer",
  customerPhone: "9000000000",
  instructions: null,
  originalFilename: "synthetic.pdf",
  expectedSizeBytes: tiny.length,
  sourcePageCount: 1,
};
const settings = {
  selectedPages: "1",
  copies: 1,
  paperSize: "A4",
  colorMode: "BW",
  sides: "SINGLE",
};
async function draft(overrides = {}) {
  const r = await request("/api/customer/drafts", {
    method: "POST",
    body: { ...draftInput, ...overrides },
  });
  assert.equal(r.status, 201);
  const token = r.body.data.draftToken;
  const key = decodeURIComponent(
    new URL(r.body.data.upload.uploadUrl).pathname
      .split("/")
      .slice(2)
      .join("/"),
  );
  await runtime.env.PDF_BUCKET.put(key, tiny);
  assert.equal(
    (
      await request("/api/customer/uploads/complete", {
        method: "POST",
        token,
        body: {},
      })
    ).status,
    200,
  );
  return { token, key };
}
async function checkout() {
  const d = await draft();
  const quote = await request("/api/customer/draft/print-settings", {
    method: "PUT",
    token: d.token,
    body: settings,
  });
  assert.equal(quote.status, 200);
  const r = await request("/api/customer/payments/create", {
    method: "POST",
    token: d.token,
    body: { acknowledgedTotalPaise: quote.body.data.totalAmountPaise },
  });
  assert.equal(r.status, 200);
  const orderId = r.body.data.razorpayOrderId,
    paymentId = orderId.replace("order_", "pay_");
  return {
    ...d,
    orderId,
    paymentId,
    verify: {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature(
        `${orderId}|${paymentId}`,
        runtime.env.RAZORPAY_KEY_SECRET,
      ),
      trackingToken: randomBytes(32).toString("base64url"),
    },
  };
}
const invalidInputs = {
  customerName: ["", "x".repeat(121)],
  customerPhone: ["", "1", "x".repeat(100), "letters", "!@#$%^"],
  instructions: ["x".repeat(1001)],
  expectedSizeBytes: [0, -1, 26214401],
  sourcePageCount: [0, -1, 1000001],
};
for (const [field, values] of Object.entries(invalidInputs))
  for (const [i, value] of values.entries())
    await check(`draft rejects ${field} case ${i}`, async () => {
      assert.equal(
        (
          await request("/api/customer/drafts", {
            method: "POST",
            body: { ...draftInput, [field]: value },
          })
        ).status,
        400,
      );
    });
for (const [label, text] of Object.entries({
  unicode: "नमस्ते🙂\u202e",
  html: "<script>harmless</script>",
  sql: "name'; SELECT 1; --",
  json: '{"synthetic":true}',
  newline: "synthetic\nline",
}))
  await check(`inert text ${label}`, async () => {
    const d = await draft({
      customerName: text,
      instructions: text,
      originalFilename: text + ".pdf",
    });
    assert.ok(d.key.startsWith("uploads/"));
    assert.ok(!d.key.includes(text));
    assert.equal(
      runtime.db.prepare("SELECT COUNT(*) AS n FROM installation").get().n,
      1,
    );
    return "stored as bound text; no rendering or OS execution";
  });
const d = await draft();
for (const [field, values] of Object.entries({
  copies: [0, -1, 1.5, 1000001, Number.MAX_SAFE_INTEGER],
  selectedPages: ["0", "-1", "999999999999", "2-1", "1,".repeat(1000)],
  paperSize: ["A2"],
  colorMode: ["FAKE"],
  sides: ["FAKE"],
}))
  for (const [i, value] of values.entries())
    await check(`settings reject ${field} case ${i}`, async () => {
      assert.equal(
        (
          await request("/api/customer/draft/print-settings", {
            method: "PUT",
            token: d.token,
            body: { ...settings, [field]: value },
          })
        ).status,
        400,
      );
    });
await check("backend accepts 101 copies but Windows rejects", async () => {
  const quote = await request("/api/customer/draft/print-settings", {
    method: "PUT",
    token: d.token,
    body: { ...settings, copies: 101 },
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.data.totalAmountPaise, 10100);
  assert.throws(() =>
    validateAndNormalizePrintSettings({
      printerId: "Synthetic 0",
      localPdfPath: "C:\\safe.pdf",
      settings: { copies: 101 },
    }),
  );
  return { finding: "API_AGENT_COPY_LIMIT_MISMATCH", quotedPaise: 10100 };
});
for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER])
  await check(`price mutation cannot create checkout ${value}`, async () => {
    const r = await request("/api/customer/payments/create", {
      method: "POST",
      token: d.token,
      body: { acknowledgedTotalPaise: value },
    });
    assert.ok(r.status === 400 || r.body.data?.status === "PRICE_CHANGED");
    assert.ok(!r.body.data?.razorpayOrderId);
  });
await check("duplicate/overlap pages normalize", async () => {
  const r = await request("/api/customer/draft/print-settings", {
    method: "PUT",
    token: d.token,
    body: { ...settings, selectedPages: "1,1-1,1" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.selectedPageCount, 1);
});
for (const path of [
  "/api/admin/settings",
  "/api/admin/pricing",
  "/api/admin/orders/live",
  "/api/admin/agents",
  "/api/admin/printers",
])
  await check(`admin anonymous ${path}`, async () => {
    assert.equal(
      (await request(path, { origin: runtime.env.ADMIN_ALLOWED_ORIGIN }))
        .status,
      401,
    );
  });
await check("foreign-origin admin mutation rejected", async () => {
  assert.equal(
    (
      await request("/api/admin/settings", {
        method: "PUT",
        body: {},
        admin: true,
        origin: "https://foreign.invalid",
      })
    ).status,
    403,
  );
});
await check("cookie attributes", async () => {
  const r = await request("/api/admin/auth/login", {
    method: "POST",
    admin: true,
    body: { loginIdentifier: "synthetic-admin", password: runtime.password },
  });
  assert.equal(r.status, 200);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"])
    assert.ok(r.headers.get("set-cookie").includes(attr));
});
await check("admin singleton database", async () => {
  assert.throws(() =>
    runtime.db
      .prepare(
        "INSERT INTO admins (id,login_identifier,password_hash,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)",
      )
      .run(crypto.randomUUID(), "second", "synthetic", Date.now(), Date.now()),
  );
});
await check("random tracking enumeration 1000 requests", async () => {
  for (let i = 0; i < 1000; i++) {
    const r = await request(
      `/api/customer/tracking/PG-${String(i).padStart(6, "0")}`,
      { token: randomBytes(32).toString("base64url") },
    );
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
    assert.ok(!("data" in r.body));
  }
});
for (const n of [10, 50, 100, 250])
  await check(`concurrent callback replay ${n}`, async () => {
    const c = await checkout();
    const before = runtime.db
      .prepare("SELECT COUNT(*) n FROM orders WHERE status='QUEUED'")
      .get().n;
    const start = performance.now();
    const replies = await Promise.all(
      Array.from({ length: n }, () =>
        request("/api/customer/payments/verify", {
          method: "POST",
          token: c.token,
          body: c.verify,
        }),
      ),
    );
    assert.ok(replies.every((r) => r.status === 200));
    assert.equal(
      runtime.db
        .prepare("SELECT COUNT(*) n FROM orders WHERE status='QUEUED'")
        .get().n,
      before + 1,
    );
    assert.equal(new Set(replies.map((r) => r.body.data.jobCode)).size, 1);
    return {
      concurrency: n,
      wallMs: performance.now() - start,
      successful: replies.length,
    };
  });
await check("webhook and callback concurrent idempotency", async () => {
  const c = await checkout();
  const webhook = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: c.paymentId,
          order_id: c.orderId,
          amount: 100,
          currency: "INR",
          status: "captured",
        },
      },
    },
  };
  const raw = JSON.stringify(webhook);
  const rs = await Promise.all([
    request("/api/customer/payments/verify", {
      method: "POST",
      token: c.token,
      body: c.verify,
    }),
    ...Array.from({ length: 50 }, () =>
      request("/api/webhooks/razorpay", {
        method: "POST",
        raw,
        headers: {
          "x-razorpay-signature": signature(
            raw,
            runtime.env.RAZORPAY_WEBHOOK_SECRET,
          ),
          "x-razorpay-event-id": "synthetic-concurrent-event",
        },
      }),
    ),
  ]);
  assert.ok(rs.every((r) => r.status === 200));
  const payment = runtime.db
    .prepare("SELECT order_id FROM payments WHERE provider_order_id=?")
    .get(c.orderId);
  assert.equal(
    runtime.db
      .prepare(
        "SELECT COUNT(*) n FROM order_events WHERE order_id=? AND event_type='PAYMENT_VERIFIED'",
      )
      .get(payment.order_id).n,
    1,
  );
});
await check("wrong payment signature denied", async () => {
  const c = await checkout();
  assert.notEqual(
    (
      await request("/api/customer/payments/verify", {
        method: "POST",
        token: c.token,
        body: { ...c.verify, razorpaySignature: "0".repeat(64) },
      })
    ).status,
    200,
  );
});
await check("payment for another draft denied", async () => {
  const a = await checkout(),
    b = await checkout();
  assert.notEqual(
    (
      await request("/api/customer/payments/verify", {
        method: "POST",
        token: b.token,
        body: a.verify,
      })
    ).status,
    200,
  );
});
for (const [label, raw, expected] of [
  ["empty", "", 400],
  ["invalid-json", "{", 400],
  ["oversize", " ".repeat(131073), 413],
])
  await check(`webhook ${label}`, async () =>
    assert.equal(
      (
        await request("/api/webhooks/razorpay", {
          method: "POST",
          raw,
          headers: { "x-razorpay-signature": "0".repeat(64) },
        })
      ).status,
      expected,
    ),
  );
await check("webhook one-byte tampering", async () => {
  const raw = '{"event":"unsupported"}';
  assert.equal(
    (
      await request("/api/webhooks/razorpay", {
        method: "POST",
        raw: raw + " ",
        headers: {
          "x-razorpay-signature": signature(
            raw,
            runtime.env.RAZORPAY_WEBHOOK_SECRET,
          ),
        },
      })
    ).status,
    400,
  );
});
await check("correctly signed unsupported webhook bounded", async () => {
  const raw = '{"event":"unsupported"}';
  assert.equal(
    (
      await request("/api/webhooks/razorpay", {
        method: "POST",
        raw,
        headers: {
          "x-razorpay-event-id": "synthetic-unsupported",
          "x-razorpay-signature": signature(
            raw,
            runtime.env.RAZORPAY_WEBHOOK_SECRET,
          ),
        },
      })
    ).status,
    200,
  );
});

await check(
  "concurrent payment create reserves one provider order",
  async () => {
    const d = await draft();
    await request("/api/customer/draft/print-settings", {
      method: "PUT",
      token: d.token,
      body: settings,
    });
    const before = runtime.totals.provider.create;
    const replies = await Promise.all(
      Array.from({ length: 100 }, () =>
        request("/api/customer/payments/create", {
          method: "POST",
          token: d.token,
          body: { acknowledgedTotalPaise: 100 },
        }),
      ),
    );
    assert.ok(replies.every((r) => [200, 409].includes(r.status)));
    assert.equal(runtime.totals.provider.create - before, 1);
    const ids = replies
      .filter((r) => r.status === 200)
      .map((r) => r.body.data.razorpayOrderId);
    assert.equal(new Set(ids).size, 1);
    return {
      requests: 100,
      providerOrders: 1,
      statuses: replies.reduce(
        (a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a),
        {},
      ),
    };
  },
);
await check(
  "stale PROCESSING webhook reproduces lost event acknowledgement",
  async () => {
    const c = await checkout(),
      now = Date.now(),
      eventId = "synthetic-stale-processing";
    runtime.db
      .prepare(
        "INSERT INTO payment_provider_events (id,provider_event_id,event_type,received_at_ms,processing_status) VALUES (?,?,'payment.captured',?,'PROCESSING')",
      )
      .run(crypto.randomUUID(), eventId, now - 10800000);
    const raw = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: c.paymentId,
            order_id: c.orderId,
            amount: 100,
            currency: "INR",
            status: "captured",
          },
        },
      },
    });
    const result = await request("/api/webhooks/razorpay", {
      method: "POST",
      raw,
      headers: {
        "x-razorpay-signature": signature(
          raw,
          runtime.env.RAZORPAY_WEBHOOK_SECRET,
        ),
        "x-razorpay-event-id": eventId,
      },
    });
    const payment = runtime.db
      .prepare("SELECT status FROM payments WHERE provider_order_id=?")
      .get(c.orderId);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.duplicate, true);
    assert.equal(payment.status, "PENDING");
    return {
      finding: "HIGH_STALE_WEBHOOK_PROCESSING",
      httpStatus: 200,
      paymentStatus: payment.status,
      eventAgeHours: 3,
    };
  },
);
await check(
  "provider lookup failure leaves payment unpaid and retry succeeds",
  async () => {
    const c = await checkout(),
      original = globalThis.fetch;
    let failed = false;
    globalThis.fetch = async (...args) => {
      if (!failed && String(args[0]).includes("/v1/payments/")) {
        failed = true;
        throw new Error("Synthetic provider connection loss");
      }
      return original(...args);
    };
    try {
      const r = await request("/api/customer/payments/verify", {
        method: "POST",
        token: c.token,
        body: c.verify,
      });
      assert.notEqual(r.status, 200);
      assert.notEqual(
        runtime.db
          .prepare("SELECT status FROM payments WHERE provider_order_id=?")
          .get(c.orderId).status,
        "PAID",
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(
      (
        await request("/api/customer/payments/verify", {
          method: "POST",
          token: c.token,
          body: c.verify,
        })
      ).status,
      200,
    );
  },
);
await check("twenty concurrent pairing attempts consume one code", async () => {
  const now = Date.now(),
    code = "23456789";
  runtime.db
    .prepare(
      "INSERT INTO agent_pair_codes (id,code_hash,expires_at_ms,created_at_ms) VALUES (?,?,?,?)",
    )
    .run(
      crypto.randomUUID(),
      await runtime.api.hashSessionToken(code),
      now + 60000,
      now,
    );
  const rs = await Promise.all(
    Array.from({ length: 20 }, () =>
      request("/api/agent/pair", {
        method: "POST",
        body: { pairCode: code, displayName: "Synthetic race" },
      }),
    ),
  );
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 400).length, 19);
  return { successes: 1, rejections: 19 };
});
// Benign marker/object fixtures only; no scripts are executed and no OS printer is called.
const pdfFixtures = [
  ["tiny", tiny],
  ["zero", Buffer.alloc(0)],
  ["plain", Buffer.from("plain text")],
  ["png", Buffer.from([137, 80, 78, 71, 13, 10])],
  ["zip", Buffer.from("PK\u0003\u0004")],
  ["header-truncated", Buffer.from("%PDF-1.4\n")],
  ["missing-eof", tiny.subarray(0, tiny.length - 8)],
  [
    "corrupt-xref",
    Buffer.from(tiny.toString().replace("startxref\n", "startxref\n999")),
  ],
  ["malformed-objects", Buffer.from("%PDF-1.4\nnot an object\n%%EOF")],
  ["many-pages", makePdf(2000)],
  ["harmless-js-object", makePdf(1, "<</S /JavaScript /JS (void 0)>>")],
  [
    "harmless-embedded-object",
    makePdf(1, "<</Type /EmbeddedFile /Length 0>>\nstream\n\nendstream"),
  ],
  ["odd-metadata", makePdf(1, "<</Title (Synthetic metadata)>>")],
  ["huge-metadata", makePdf(1, `<</Title (${"x".repeat(1024 * 1024)})>>`)],
];
for (const [name, bytes] of pdfFixtures) {
  let agentAccepted = false;
  const started = performance.now();
  const store = {
    async head() {
      return { size: bytes.length };
    },
    async readPrefix(k, n) {
      return Uint8Array.from(bytes.subarray(0, n)).buffer;
    },
    async delete() {},
  };
  const workerAccepted = (
    await verifyPdfObject(store, {
      key: "synthetic",
      expectedSizeBytes: bytes.length,
      maximumSizeBytes: 26214400,
    })
  ).ok;
  try {
    const local = await downloadAndValidateCustomerPdf(
      {
        url: "https://synthetic.invalid/file",
        expectedSizeBytes: bytes.length,
        sourcePageCount: 1,
        pageRange: "1",
      },
      async () => new Response(bytes),
      resolve(dir),
    );
    agentAccepted = true;
    await local.cleanup();
  } catch {
    /* Expected validation rejections are recorded without document contents. */
  }
  results.push({
    name: `PDF ${name}`,
    status: "OBSERVED",
    evidence: {
      bytes: bytes.length,
      workerAccepted,
      agentAccepted,
      wallMs: performance.now() - started,
    },
  });
}
for (const size of [26214400, 26214401])
  await check(`PDF size boundary ${size}`, async () => {
    const bytes = Buffer.alloc(size, 32);
    tiny.copy(bytes);
    Buffer.from("%%EOF").copy(bytes, size - 5);
    const store = {
      async head() {
        return { size };
      },
      async readPrefix(k, n) {
        return Uint8Array.from(bytes.subarray(0, n)).buffer;
      },
      async delete() {},
    };
    assert.equal(
      (
        await verifyPdfObject(store, {
          key: "synthetic",
          expectedSizeBytes: size,
          maximumSizeBytes: 26214400,
        })
      ).ok,
      size === 26214400,
    );
  });
for (const printer of ['Safe" quote', "Safe\nline"])
  await check(
    "unsafe printer boundary rejected " + JSON.stringify(printer),
    async () =>
      assert.throws(() =>
        validateAndNormalizePrintSettings({
          printerId: printer,
          localPdfPath: "C:\\safe.pdf",
          settings: { copies: 1 },
        }),
      ),
  );
for (const path of ['C:\\safe".pdf', "C:\\safe\n.pdf"])
  await check("unsafe path boundary rejected", async () =>
    assert.throws(() =>
      validateAndNormalizePrintSettings({
        printerId: "Synthetic",
        localPdfPath: path,
        settings: { copies: 1 },
      }),
    ),
  );
await check("logout invalidates cookie", async () => {
  assert.equal(
    (
      await request("/api/admin/auth/logout", {
        method: "POST",
        admin: true,
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/admin/orders/live", { admin: true })).status,
    401,
  );
});
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/security-matrix.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      results,
      latencies: Object.fromEntries(
        [...latencies].map(([k, h]) => [k, h.snapshot()]),
      ),
      operations: runtime.totals,
    },
    null,
    2,
  ) + "\n",
);
runtime.close();
console.log(
  JSON.stringify({
    checks: results.length,
    failed: results.filter((x) => x.status === "FAIL"),
  }),
);
