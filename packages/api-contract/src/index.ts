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
  token?: string;
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
  token?: string;
  message: string;
}

export type AdminChangePasswordResponse = ApiResponse<AdminChangePasswordData>;

export interface AdminLogoutData {
  message: string;
}

export type AdminLogoutResponse = ApiResponse<AdminLogoutData>;

export interface ShopSettings {
  logoUrl?: string | null;
  appName?: string;
  shopName: string;
  contactPhone: string | null;
  address: string | null;
  customerNotice: string | null;
  onlinePrintingEnabled: boolean;
  maxPdfSizeBytes: number;
  maxOrderUploadBytes?: number;
  identificationSheetEnabled: boolean;
  identificationSheetPlacement: IdentificationSheetPlacement;
  automaticDailyCleanupEnabled?: boolean;
  dailyCleanupTime?: string;
  timezone?: string;
  lastCleanupAt?: string | null;
  nextCleanupAt?: string | null;
  lastCleanupResult?: string | null;
  priorityPrintingEnabled?: boolean;
  priorityFeePaise?: number;
  idRequirementMode?: "OFF" | "ALWAYS" | "ABOVE_THRESHOLD";
  idThresholdPaise?: number;
  nextPickupCode?: string;
  orderRetentionHours?: number;
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

export type HandlingMode = "AUTO" | "POST_PRINT" | "MANUAL_PRINT";
export type PricingType = "FIXED_PRICE" | "STAFF_PRICED";

/** Stored add-on service record (admin view). */
export interface AdminAddonService {
  id: string;
  name: string;
  pricingType: PricingType;
  /** Price in paise. Only charged online when pricingType = FIXED_PRICE. Null for STAFF_PRICED. */
  fixedPricePaise: number | null;
  handlingMode: HandlingMode;
  enabled: boolean;
  displayOrder: number;
}

/** Payload for creating / updating an add-on service. */
export interface AdminAddonServiceRequest {
  name: string;
  pricingType: PricingType;
  fixedPricePaise: number | null;
  handlingMode: HandlingMode;
  enabled: boolean;
  displayOrder: number;
}

export interface AdminAddonServicesData {
  addonServices: AdminAddonService[];
}
export type AdminAddonServicesResponse = ApiResponse<AdminAddonServicesData>;
export type AdminAddonServiceResponse = ApiResponse<{
  addonService: AdminAddonService;
}>;

export interface AdminDiscountRule {
  id: string;
  minSubtotalPaise: number;
  discountPercent: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDiscountRuleRequest {
  minSubtotalPaise: number;
  discountPercent: number;
  enabled: boolean;
}

export interface AdminDiscountRulesData {
  discountRules: AdminDiscountRule[];
}

export type AdminDiscountRulesResponse = ApiResponse<AdminDiscountRulesData>;
export type AdminDiscountRuleResponse = ApiResponse<{
  discountRule: AdminDiscountRule;
}>;

export interface AdminPricingConfiguration {
  /** Read-only context from Shop Settings. Updated through the settings API. */
  maxPdfSizeBytes: number;
  printRates: AdminPrintRate[];
  fileSizeServiceCharges: AdminFileSizeServiceCharge[];
  /** Included for convenience on GET /api/admin/pricing. Managed via /api/admin/addon-services. */
  addonServices?: AdminAddonService[];
  priorityPrinting?: {
    enabled: boolean;
    feePaise: number;
  };
  discountRules?: AdminDiscountRule[];
}

/**
 * Pricing update request — covers print rates, file-size charges, and priority printing.
 * Add-on services are managed via dedicated /api/admin/addon-services endpoints.
 * Discount rules are managed via dedicated /api/admin/discount-rules endpoints.
 */
export interface AdminPricingUpdateRequest {
  printRates: AdminPrintRate[];
  fileSizeServiceCharges: AdminFileSizeServiceCharge[];
  priorityPrinting?: {
    enabled: boolean;
    feePaise: number;
  };
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
  pricePerPagePaise?: number;
}

/** Add-on service as shown to the customer. */
export interface CustomerAddonService {
  id: string;
  name: string;
  pricingType: PricingType;
  /** Price in paise for FIXED_PRICE; 0 for STAFF_PRICED (priced at pickup). */
  fixedPricePaise: number;
}

export interface CustomerConfigData {
  logoUrl?: string | null;
  appName?: string;
  shopName: string;
  contactPhone: string | null;
  address?: string | null;
  customerNotice: string | null;
  onlinePrintingEnabled: boolean;
  maxPdfSizeBytes: number;
  maxOrderUploadBytes?: number;
  maxOrderFiles?: number;
  availablePrintOptions: CustomerPrintOption[];
  /** Add-on services available for customer selection. */
  addonServices?: CustomerAddonService[];
  /** Priority printing option. */
  priorityPrinting?: {
    enabled: boolean;
    feePaise: number;
  };
  /** Identification requirement policy. */
  identificationPolicy?: {
    mode: "OFF" | "ALWAYS" | "ABOVE_THRESHOLD";
    thresholdPaise: number;
  };
  /** Active discount tiers. */
  discountRules?: Array<{
    id: string;
    minSubtotalPaise: number;
    discountPercent: number;
  }>;
}

export type CustomerConfigResponse = ApiResponse<CustomerConfigData>;

/** Snapshot of a single add-on service as recorded at order time. */
export interface OrderAddonServiceSnapshot {
  serviceId: string;
  serviceName: string;
  pricingType: PricingType;
  /** Amount charged online in paise. 0 for STAFF_PRICED. */
  onlinePricePaise: number;
  handlingMode: HandlingMode;
}

/** Admin view of a manual-print order. */
export interface AdminManualOrder {
  orderId: string;
  jobCode: string;
  customerName: string;
  customerPhone: string;
  status: string;
  instructions: string | null;
  fileCount: number;
  onlineAmountPaise: number;
  dueAtPickupPaise: number;
  currency: "INR";
  paidAt: string;
  addonServices: OrderAddonServiceSnapshot[];
  hasStaffPriced: boolean;
  hasPostPrint: boolean;
  pickupCode?: string | null;
  isPriority?: boolean;
  identificationRequired?: boolean;
}

export type AdminManualOrdersResponse = ApiResponse<{
  orders: AdminManualOrder[];
  nextCursor: string | null;
}>;

export interface AdminSetPickupChargeRequest {
  dueAtPickupPaise: number;
}

export type AdminSetPickupChargeResponse = ApiResponse<{
  orderId: string;
  dueAtPickupPaise: number;
}>;

export interface CreateCustomerDraftRequest {
  customerName: string;
  customerPhone: string;
  instructions: string | null;
  originalFilename: string;
  expectedSizeBytes: number;
  sourcePageCount: number;
  addonServiceIds?: string[];
  isPriority?: boolean;
}

export interface UploadAuthorization {
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface CreateCustomerDraftData {
  draftToken: string;
  draftExpiresAt: string;
  fileId?: string;
  position?: number;
  upload: UploadAuthorization;
}

export type CreateCustomerDraftResponse = ApiResponse<CreateCustomerDraftData>;

export interface CompleteCustomerUploadData {
  fileId?: string;
  sizeBytes: number;
  uploadedAt: string;
  draftExpiresAt: string;
}

export type CompleteCustomerUploadResponse =
  ApiResponse<CompleteCustomerUploadData>;

export interface CustomerPrintSettingsRequest {
  fileId?: string;
  selectedPages: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

export interface AddCustomerFileRequest {
  originalFilename: string;
  expectedSizeBytes: number;
  sourcePageCount: number;
}

export interface AddCustomerFileData {
  fileId: string;
  position: number;
  draftExpiresAt: string;
  upload: UploadAuthorization;
}

export interface CustomerOrderFileData {
  fileId: string;
  originalFilename: string;
  sizeBytes: number | null;
  sourcePageCount: number;
  selectedPages: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  printingAmountPaise: number;
  serviceChargePaise: number;
  uploadStatus: string;
}

export interface CustomerDraftData {
  customerName: string;
  customerPhone: string;
  instructions: string | null;
  status: string;
  files: CustomerOrderFileData[];
  isPriority?: boolean;
}

export interface CustomerOrderQuoteRequest {
  files: Array<CustomerPrintSettingsRequest & { fileId: string }>;
  isPriority?: boolean;
}

export interface CustomerFileQuoteData extends CustomerOrderFileData {
  selectedPageCount: number;
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
  files?: CustomerFileQuoteData[];
  addonAmountPaise?: number;
  addonServices?: OrderAddonServiceSnapshot[];
  isPriority?: boolean;
  priorityFeePaise?: number;
  subtotalAmountPaise?: number;
  discountAmountPaise?: number;
  appliedDiscount?: {
    minSubtotalPaise: number;
    discountPercent: number;
  } | null;
  identificationRequired?: boolean;
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
  pickupCode?: string | null;
  amountPaidPaise: number;
  currency: "INR";
  status: "QUEUED" | "MANUAL_PRINT";
  message: string;
  trackingToken: string;
  trackingExpiresAt: string;
  isPriority?: boolean;
  identificationRequired?: boolean;
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
  pickupCode?: string | null;
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
  fileId?: string;
  filePosition?: number;
  fileCount?: number;
  originalFilename?: string;
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
  pickupCode?: string | null;
  isPriority?: boolean;
  identificationRequired?: boolean;
  errorCategory?: string | null;
  rawError?: string | null;
  attemptCount?: number;
  lastAttemptAt?: string | null;
  nextRetryAt?: string | null;
}
export type AdminLiveOrdersResponse = ApiResponse<{ orders: AdminLiveOrder[] }>;

export interface AdminOrderHistoryEntry {
  orderId: string;
  pickupCode: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  createdAt: string;
  completedAt: string | null;
  isPriority: boolean;
  isManual: boolean;
  addonServices: {
    name: string;
    onlinePricePaise: number;
    handlingMode: string;
  }[];
  onlinePaidPaise: number;
  dueAtPickupPaise: number;
  status: string;
  printerUsed: string | null;
  fallbackPrinter: string | null;
  attemptCount: number;
  failureHistory: { status: string; code: string | null; at: string | null }[];
  purged: boolean;
}

export type AdminOrderHistoryResponse = ApiResponse<{
  orders: AdminOrderHistoryEntry[];
  nextCursor: string | null;
}>;

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
  isPaused?: boolean;
  pausedReason?: string | null;
  pausedAt?: string | null;
  lastHealthCheckAt?: string | null;
  healthCheckRequested?: boolean;
  /** ID of the fallback printer to use when this printer is unavailable. */
  fallbackPrinterId?: string | null;
  /** Whether automatic fallback routing is enabled for this printer. */
  autoFallbackEnabled?: boolean;
}

export interface AdminCheckPrinterHealthResponseData {
  printerId: string;
  isPaused: boolean;
  status: string;
  message: string;
}

export type AdminCheckPrinterHealthResponse =
  ApiResponse<AdminCheckPrinterHealthResponseData>;

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
  status: "COMPLETED" | "AWAITING_FINISHING";
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

export interface AdminConfigureFallbackRequest {
  fallbackPrinterId: string | null;
  autoFallbackEnabled: boolean;
}

export interface AdminConfigureFallbackResponseData {
  printerId: string;
  fallbackPrinterId: string | null;
  autoFallbackEnabled: boolean;
}

export type AdminConfigureFallbackResponse =
  ApiResponse<AdminConfigureFallbackResponseData>;

export interface IdentificationSheetAddonService {
  name: string;
  pricingType: "FIXED_PRICE" | "STAFF_PRICED";
  priceChargedOnlinePaise: number;
  handlingMode: "AUTO" | "POST_PRINT" | "MANUAL_PRINT";
}

export interface IdentificationSheetData {
  /** Private Agent payload, only for the intentional physical sheet. Never log. */
  customerPhone?: string;
  jobCode: string;
  pickupCode?: string | null;
  customerName: string;
  maskedPhone: string;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  pageRange: string;
  copies: number;
  amountPaidPaise: number;
  dueAtPickupPaise?: number;
  currency: "INR";
  instructions: string | null;
  paidAtMs: number;
  shopName?: string | undefined;
  addonServices?: IdentificationSheetAddonService[];
}

export interface AdminDashboardData {
  settings: ShopSettings | null;
  agents: AdminAgentDetails[];
  defaultProductionPrinterId: string | null;
  todaysEarningsPaise: number;
  todaysOrders: number;
  inQueue: number;
  printingNow: number;
  statusCounts: {
    waiting: number;
    printing: number;
    readyForPickup: number;
    needsAttention: number;
  };
}

export type CleanupScope =
  "EXPIRED_UNPAID" | "COMPLETED_DUE" | "ALL_COMPLETED" | "ALL_PRINT_DATA";

export interface AdminCleanupPreviewData {
  scope: CleanupScope;
  orders: number;
  files: number;
  bytes: number;
  active: number;
  limited?: boolean;
}

export interface AdminCleanupRunData extends AdminCleanupPreviewData {
  runId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
  deletedOrders: number;
  deletedFiles: number;
  deletedBytes: number;
  activeSkipped: number;
  failures: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type AdminCleanupPreviewResponse = ApiResponse<AdminCleanupPreviewData>;
export type AdminCleanupRunResponse = ApiResponse<AdminCleanupRunData>;

export type PublicTrackingStatus =
  | "QUEUED"
  | "PRIORITY_QUEUE"
  | "PRINTING"
  | "RETRYING"
  | "PRINTER_ISSUE"
  | "WAITING_FOR_STAFF"
  | "FINISHING"
  | "READY_FOR_PICKUP";

export interface PublicOrderTrackingData {
  pickupCode: string;
  status: PublicTrackingStatus;
  statusLabel: string;
  statusMessage: string;
  isPriority: boolean;
  totalFiles: number;
  completedFiles: number;
  identificationRequired: boolean;
  createdAt: string;
  completedAt?: string | null;
}

export type PublicOrderTrackingResponse = ApiResponse<PublicOrderTrackingData>;

export type AdminResetPickupCodeResponse = ApiResponse<{
  message: string;
  nextPickupCode: string;
}>;
