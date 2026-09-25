export interface WorkerEnv {
  /** Configured for the current installation when its local/production D1 exists. */
  DB?: D1Database;
  /** Added when Phase 4 provisions the private upload bucket. */
  PDF_BUCKET?: R2Bucket;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  SESSION_SIGNING_KEY?: string;
}
