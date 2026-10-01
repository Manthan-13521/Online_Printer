import type {
  AdminDiscountRule,
  AdminDiscountRuleRequest,
} from "@printgo/api-contract";
import type { DiscountRuleInput } from "@printgo/pricing";

interface DiscountRuleRow {
  id: string;
  min_subtotal_paise: number;
  discount_percent: number;
  enabled: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export class DiscountRuleError extends Error {
  constructor(
    readonly code: "DISCOUNT_RULE_NOT_FOUND" | "INVALID_DISCOUNT_RULE",
    message: string,
  ) {
    super(message);
    this.name = "DiscountRuleError";
  }
}

export class D1DiscountRuleRepository {
  constructor(private readonly db: D1Database) {}

  async listRules(): Promise<AdminDiscountRule[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, min_subtotal_paise, discount_percent, enabled, created_at_ms, updated_at_ms
         FROM discount_rules
         ORDER BY min_subtotal_paise ASC`,
      )
      .all<DiscountRuleRow>();

    return (results ?? []).map((row) => ({
      id: row.id,
      minSubtotalPaise: row.min_subtotal_paise,
      discountPercent: row.discount_percent,
      enabled: row.enabled === 1,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    }));
  }

  async listActiveRules(): Promise<DiscountRuleInput[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, min_subtotal_paise, discount_percent, enabled
         FROM discount_rules
         WHERE enabled = 1
         ORDER BY min_subtotal_paise DESC`,
      )
      .all<DiscountRuleRow>();

    return (results ?? []).map((row) => ({
      id: row.id,
      minSubtotalPaise: row.min_subtotal_paise,
      discountPercent: row.discount_percent,
      enabled: true,
    }));
  }

  async getRule(id: string): Promise<AdminDiscountRule | null> {
    const row = await this.db
      .prepare(
        `SELECT id, min_subtotal_paise, discount_percent, enabled, created_at_ms, updated_at_ms
         FROM discount_rules
         WHERE id = ?`,
      )
      .bind(id)
      .first<DiscountRuleRow>();

    if (!row) return null;
    return {
      id: row.id,
      minSubtotalPaise: row.min_subtotal_paise,
      discountPercent: row.discount_percent,
      enabled: row.enabled === 1,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    };
  }

  async createRule(
    input: AdminDiscountRuleRequest,
    nowMs: number,
  ): Promise<AdminDiscountRule> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO discount_rules (id, min_subtotal_paise, discount_percent, enabled, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.minSubtotalPaise,
        input.discountPercent,
        input.enabled ? 1 : 0,
        nowMs,
        nowMs,
      )
      .run();

    return {
      id,
      minSubtotalPaise: input.minSubtotalPaise,
      discountPercent: input.discountPercent,
      enabled: input.enabled,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
  }

  async updateRule(
    id: string,
    input: Partial<AdminDiscountRuleRequest>,
    nowMs: number,
  ): Promise<AdminDiscountRule> {
    const existing = await this.getRule(id);
    if (!existing) {
      throw new DiscountRuleError(
        "DISCOUNT_RULE_NOT_FOUND",
        "Discount rule not found.",
      );
    }

    const minSubtotalPaise =
      input.minSubtotalPaise ?? existing.minSubtotalPaise;
    const discountPercent = input.discountPercent ?? existing.discountPercent;
    const enabled = input.enabled ?? existing.enabled;

    await this.db
      .prepare(
        `UPDATE discount_rules
         SET min_subtotal_paise = ?, discount_percent = ?, enabled = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .bind(minSubtotalPaise, discountPercent, enabled ? 1 : 0, nowMs, id)
      .run();

    return {
      id,
      minSubtotalPaise,
      discountPercent,
      enabled,
      createdAt: existing.createdAt,
      updatedAt: new Date(nowMs).toISOString(),
    };
  }

  async deleteRule(id: string): Promise<void> {
    const result = await this.db
      .prepare(`DELETE FROM discount_rules WHERE id = ?`)
      .bind(id)
      .run();
    if (result.meta.changes === 0) {
      throw new DiscountRuleError(
        "DISCOUNT_RULE_NOT_FOUND",
        "Discount rule not found.",
      );
    }
  }

  async toggleRule(id: string, nowMs: number): Promise<AdminDiscountRule> {
    const existing = await this.getRule(id);
    if (!existing) {
      throw new DiscountRuleError(
        "DISCOUNT_RULE_NOT_FOUND",
        "Discount rule not found.",
      );
    }
    const newEnabled = !existing.enabled;
    await this.db
      .prepare(
        `UPDATE discount_rules SET enabled = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .bind(newEnabled ? 1 : 0, nowMs, id)
      .run();

    return {
      ...existing,
      enabled: newEnabled,
      updatedAt: new Date(nowMs).toISOString(),
    };
  }
}
