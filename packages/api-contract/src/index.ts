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
