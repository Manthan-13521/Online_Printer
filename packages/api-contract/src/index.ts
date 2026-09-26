import type {
  ColorMode,
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
