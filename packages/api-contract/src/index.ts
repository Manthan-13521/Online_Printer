import type {
  ColorMode,
  CustomerOrderStatus,
  IdentificationSheetPlacement,
  PaperSize,
  SidesMode,
} from "@printgo/domain";

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccess<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function apiFailure(code: string, message: string): ApiFailure {
  return { ok: false, error: { code, message } };
}

export interface AdminProfile {
  id: string;
  loginIdentifier: string;
}

export interface AdminLoginRequest {
  loginIdentifier: string;
  password: string;
}

export interface AdminLoginData {
  admin: AdminProfile;
}

export type AdminLoginResponse = ApiResponse<AdminLoginData>;
export type AdminMeResponse = ApiResponse<AdminLoginData>;

export interface AdminChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
}

export interface AdminChangePasswordData {
  admin: AdminProfile;
  message: string;
}

export type AdminChangePasswordResponse = ApiResponse<AdminChangePasswordData>;

export interface AdminLogoutData {
  message: string;
}

export type AdminLogoutResponse = ApiResponse<AdminLogoutData>;

export interface ShopSettings {
  logoUrl?: string | null;
  shopName: string;
  contactPhone: string | null;
  address: string | null;
  customerNotice: string | null;
  onlinePrintingEnabled: boolean;
  maxPdfSizeBytes: number;
  identificationSheetEnabled: boolean;
  identificationSheetPlacement: IdentificationSheetPlacement;
}

export interface AdminSettingsData {
  settings: ShopSettings;
  message?: string;
}

export type AdminSettingsResponse = ApiResponse<AdminSettingsData>;
export type AdminSettingsUpdateRequest = ShopSettings;

export interface AdminPrintRate {
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  pricePerPagePaise: number;
  enabled: boolean;
}

export interface AdminFileSizeServiceCharge {
  minBytesExclusive: number;
  maxBytesInclusive: number;
  chargePaise: number;
}

export interface AdminPricingConfiguration {
  /** Read-only context from Shop Settings. Updated through the settings API. */
  maxPdfSizeBytes: number;
  printRates: AdminPrintRate[];
  fileSizeServiceCharges: AdminFileSizeServiceCharge[];
}

export interface AdminPricingUpdateRequest {
  printRates: AdminPrintRate[];
  fileSizeServiceCharges: AdminFileSizeServiceCharge[];
}

export interface AdminPricingData {
  pricing: AdminPricingConfiguration;
  message?: string;
}

export type AdminPricingResponse = ApiResponse<AdminPricingData>;

export interface CustomerPrintOption {
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

export interface CustomerConfigData {
  logoUrl?: string | null;
  shopName: string;
  contactPhone: string | null;
  customerNotice: string | null;
  onlinePrintingEnabled: boolean;
  maxPdfSizeBytes: number;
  availablePrintOptions: CustomerPrintOption[];
}

export type CustomerConfigResponse = ApiResponse<CustomerConfigData>;

export interface CreateCustomerDraftRequest {
  customerName: string;
  customerPhone: string;
  instructions: string | null;
  originalFilename: string;
  expectedSizeBytes: number;
  sourcePageCount: number;
}

export interface UploadAuthorization {
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface CreateCustomerDraftData {
  draftToken: string;
  draftExpiresAt: string;
  upload: UploadAuthorization;
}

export type CreateCustomerDraftResponse = ApiResponse<CreateCustomerDraftData>;

export interface CompleteCustomerUploadData {
  sizeBytes: number;
  uploadedAt: string;
  draftExpiresAt: string;
}

export type CompleteCustomerUploadResponse =
  ApiResponse<CompleteCustomerUploadData>;

export interface CustomerPrintSettingsRequest {
  selectedPages: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

export interface CustomerQuoteData {
  normalizedSelectedPages: string;
  selectedPageCount: number;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  printingAmountPaise: number;
  serviceChargePaise: number;
  totalAmountPaise: number;
  currency: "INR";
  expiresAt: string;
}

export type CustomerQuoteResponse = ApiResponse<CustomerQuoteData>;

export interface CreateCustomerPaymentRequest {
  /** The last server quote explicitly reviewed by the customer. */
  acknowledgedTotalPaise: number;
}

export interface CustomerPaymentCheckoutData {
  status: "CHECKOUT_READY";
  razorpayKeyId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: "INR";
  shopName: string;
  customerName: string;
  customerPhone: string;
  description: string;
}

export interface CustomerPaymentPriceChangedData {
  status: "PRICE_CHANGED";
  quote: CustomerQuoteData;
}

export type CreateCustomerPaymentData =
  CustomerPaymentCheckoutData | CustomerPaymentPriceChangedData;

export type CreateCustomerPaymentResponse =
  ApiResponse<CreateCustomerPaymentData>;

export interface VerifyCustomerPaymentRequest {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  /** A browser-generated 32-byte opaque credential, Base64URL encoded. */
  trackingToken: string;
}

export interface CustomerPaymentSuccessData {
  jobCode: string;
  amountPaidPaise: number;
  currency: "INR";
  status: "QUEUED";
  message: string;
  trackingToken: string;
  trackingExpiresAt: string;
}

export type VerifyCustomerPaymentResponse =
  ApiResponse<CustomerPaymentSuccessData>;

export type CustomerTrackingStatus = CustomerOrderStatus;

export interface CustomerSafeTimelineEvent {
  status: "PAYMENT_RECEIVED" | CustomerTrackingStatus;
  label: string;
  occurredAt: string;
}

export interface CustomerTrackingPrintSummary {
  selectedPages: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

export type CustomerFileRetentionStatus =
  "TEMPORARILY_RETAINED" | "DELETION_PENDING" | "DELETED";

export interface CustomerTrackingData {
  jobCode: string;
  customerName: string;
  paymentStatus: "PAYMENT_RECEIVED";
  orderStatus: CustomerTrackingStatus;
  statusLabel: string;
  statusMessage: string;
  submittedAt: string;
  paidAt: string;
  printSummary: CustomerTrackingPrintSummary;
  amountPaidPaise: number;
  currency: "INR";
  instructions: string | null;
  fileRetentionStatus: CustomerFileRetentionStatus;
  timeline: CustomerSafeTimelineEvent[];
  trackingExpiresAt: string;
}

export type CustomerTrackingResponse = ApiResponse<CustomerTrackingData>;

export interface CancelCustomerPaymentRequest {
  razorpayOrderId: string;
}

export interface CancelCustomerPaymentData {
  status: "PAYMENT_CANCELLED";
  retainedUntil: string;
}

export type CancelCustomerPaymentResponse =
  ApiResponse<CancelCustomerPaymentData>;

export interface AdminCreatePairCodeData {
  pairCode: string;
  expiresAt: string;
}

export type AdminCreatePairCodeResponse = ApiResponse<AdminCreatePairCodeData>;

export interface AgentPairRequest {
  pairCode: string;
  displayName: string;
}

export interface AgentPairData {
  agentId: string;
  agentSecret: string;
  displayName: string;
}

export type AgentPairResponse = ApiResponse<AgentPairData>;

export interface PrinterCapabilitySummary {
  colour: boolean | "UNKNOWN";
  duplex: boolean | "UNKNOWN";
  paperSizes: readonly string[];
}

export interface AgentPrinterReport {
  windowsPrinterName: string;
  displayName: string;
  isDefault?: boolean;
  status: "ONLINE" | "OFFLINE" | "BLOCKED" | "ERROR" | "UNKNOWN";
  statusReason?: string | null;
  capabilities?: PrinterCapabilitySummary;
  isEligibleForProductionPrint?: boolean;
  isVirtual?: boolean;
  portName?: string | null;
  driverName?: string | null;
}

export interface AgentHeartbeatRequest {
  agentVersion: string;
  operationalState: "ONLINE" | "PAUSED" | "ERROR";
  printers: readonly AgentPrinterReport[];
}

export interface AgentTestPrintCommand {
  type: "TEST_PRINT";
  commandId: string;
  printerId: string;
  windowsPrinterName: string;
  printerDisplayName: string;
  shopName: string;
  expiresAtMs: number;
}

export interface AgentHeartbeatData {
  acknowledged: true;
  serverTimeMs: number;
  onlinePrintingEnabled?: boolean;
  nextCommand?: AgentTestPrintCommand | null;
  printJob?: AgentPrintJob | null;
}

export type AgentHeartbeatResponse = ApiResponse<AgentHeartbeatData>;

export interface AgentReportCommandRequest {
  status: "SUBMITTED" | "BLOCKED" | "SUCCEEDED" | "FAILED";
  spoolerJobId?: string | null;
  failureCode?: string | null;
  failureDetail?: string | null;
}

export interface AgentReportCommandData {
  acknowledged: true;
  commandId: string;
  status: "SUBMITTED" | "BLOCKED" | "SUCCEEDED" | "FAILED";
}

export type AgentReportCommandResponse = ApiResponse<AgentReportCommandData>;

export type PrintPlanStepType = "IDENTIFICATION_SHEET" | "CUSTOMER_DOCUMENT";
export type PrintPlanStepStatus =
  | "PENDING"
  | "SUBMISSION_STARTED"
  | "SUBMITTED"
  | "BLOCKED"
  | "SUCCEEDED"
  | "FAILED"
  | "UNCERTAIN";

export interface AgentPrintJobStep {
  stepId: string;
  sequenceNumber: number;
  type: PrintPlanStepType;
  status: PrintPlanStepStatus;
  spoolerJobId: string | null;
}

export interface AgentPrintJob {
  type: "PAID_PRINT_JOB";
  orderId: string;
  attemptId: string;
  claimId: string;
  leaseExpiresAtMs: number;
  jobCode: string;
  printerId: string;
  windowsPrinterName: string;
  download: { url: string; expiresAtMs: number; expectedSizeBytes: number };
  sourcePageCount: number;
  settings: {
    pageRange: string;
    copies: number;
    paperSize: PaperSize;
    colorMode: ColorMode;
    sides: SidesMode;
  };
  identificationSheet: IdentificationSheetData | null;
  currentStep: AgentPrintJobStep;
}

export interface AgentStartPrintStepRequest {
  claimId: string;
}
export interface AgentSubmitPrintStepRequest {
  claimId: string;
  spoolerJobId: string;
}
export interface AgentReportPrintStepRequest {
  claimId: string;
  status: "BLOCKED" | "SUCCEEDED" | "FAILED" | "UNCERTAIN";
  spoolerJobId?: string | null;
  failureCode?: string | null;
  failureDetail?: string | null;
}
export interface AgentPrintStepData {
  acknowledged: true;
  orderId: string;
  attemptId: string;
  stepId: string;
  status: PrintPlanStepStatus;
  orderStatus: string;
}
export type AgentPrintStepResponse = ApiResponse<AgentPrintStepData>;

export interface AdminLiveOrder {
  orderId: string;
  jobCode: string;
  customerName: string;
  customerPhone: string;
  printSummary: CustomerTrackingPrintSummary;
  amountPaidPaise: number;
  currency: "INR";
  status: string;
  agentName: string | null;
  printerName: string | null;
  issue: string | null;
  paidAt: string;
  updatedAt: string;
}
export type AdminLiveOrdersResponse = ApiResponse<{ orders: AdminLiveOrder[] }>;

export type TestPrintCommandStatus =
  | "PENDING"
  | "CLAIMED"
  | "SUBMITTED"
  | "BLOCKED"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED";

export interface AdminTestPrintDetails {
  commandId: string;
  printerId: string;
  agentId: string;
  status: TestPrintCommandStatus;
  spoolerJobId: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

export interface AdminTestPrintResponseData {
  testPrint: AdminTestPrintDetails;
}

export type AdminTestPrintResponse = ApiResponse<AdminTestPrintResponseData>;

export interface AdminPrinterDetails {
  id: string;
  agentId: string;
  displayName: string;
  windowsPrinterName: string;
  enabled: boolean;
  status: "ONLINE" | "OFFLINE" | "BLOCKED" | "ERROR" | "UNKNOWN";
  statusReason: string | null;
  capabilities: PrinterCapabilitySummary | null;
  lastStatusAt: string | null;
  latestTestPrint?: AdminTestPrintDetails | null;
  isProductionEligible: boolean;
  isVirtual: boolean;
  isProductionDefault: boolean;
  portName?: string | null;
  driverName?: string | null;
}

export interface AdminAgentDetails {
  id: string;
  displayName: string;
  isActive: boolean;
  isOnline: boolean;
  pairedAt: string | null;
  lastHeartbeatAt: string | null;
  printers: AdminPrinterDetails[];
}

export interface AdminPrintersData {
  agents: AdminAgentDetails[];
  defaultProductionPrinterId?: string | null;
}

export type AdminPrintersResponse = ApiResponse<AdminPrintersData>;

export interface AdminTogglePrinterRequest {
  enabled: boolean;
}

export type AdminTogglePrinterResponse = ApiResponse<{
  id: string;
  enabled: boolean;
}>;

export interface AdminSetDefaultPrinterResponseData {
  defaultPrinterId: string;
  windowsPrinterName: string;
}

export type AdminSetDefaultPrinterResponse =
  ApiResponse<AdminSetDefaultPrinterResponseData>;

export interface AdminManualCompleteOrderRequest {
  reason?: string;
}

export interface AdminManualCompleteOrderResponseData {
  orderId: string;
  status: "COMPLETED";
}

export type AdminManualCompleteOrderResponse =
  ApiResponse<AdminManualCompleteOrderResponseData>;

export interface AdminRetryOrderRequest {
  forceUncertain?: boolean;
}

export interface AdminRetryOrderResponseData {
  orderId: string;
  status: "QUEUED";
}

export type AdminRetryOrderResponse = ApiResponse<AdminRetryOrderResponseData>;

export interface AdminOrderPdfUrlResponseData {
  downloadUrl: string;
  expiresAtMs: number;
}

export type AdminOrderPdfUrlResponse =
  ApiResponse<AdminOrderPdfUrlResponseData>;

export type AdminRevokeAgentResponse = ApiResponse<{
  revoked: true;
}>;

export interface IdentificationSheetData {
  /** Private Agent payload, only for the intentional physical sheet. Never log. */
  customerPhone?: string;
  jobCode: string;
  customerName: string;
  maskedPhone: string;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  pageRange: string;
  copies: number;
  amountPaidPaise: number;
  currency: "INR";
  instructions: string | null;
  paidAtMs: number;
  shopName?: string | undefined;
}

export interface AdminDashboardData {
  settings: ShopSettings | null;
  agents: AdminAgentDetails[];
  defaultProductionPrinterId: string | null;
  queue: number;
  attention: number;
  completedToday: number;
}
