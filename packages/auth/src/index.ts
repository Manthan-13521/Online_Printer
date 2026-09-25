declare const secretValueBrand: unique symbol;

/** Marks values that must never be logged or sent to an unauthorized client. */
export type SecretValue = string & { readonly [secretValueBrand]: true };

export interface AuthenticatedAgent {
  agentId: string;
  authenticatedAt: string;
}

export interface AuthenticatedAdmin {
  adminId: string;
  sessionId: string;
  authenticatedAt: string;
}
