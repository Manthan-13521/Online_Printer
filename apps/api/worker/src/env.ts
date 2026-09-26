export interface WorkerEnv {
  DB: D1Database;
  APP_ENV: "development" | "production";
  ADMIN_ALLOWED_ORIGIN: string;
  CUSTOMER_ALLOWED_ORIGIN: string;
  PDF_BUCKET: R2Bucket;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  PAYMENT_READINESS_DEV_BYPASS?: string;
}
