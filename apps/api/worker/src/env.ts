export interface WorkerEnv {
  DB: D1Database;
  APP_ENV: "development" | "production";
  ADMIN_ALLOWED_ORIGIN: string;
  /** Added when Phase 4 provisions the private upload bucket. */
  PDF_BUCKET?: R2Bucket;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
}
