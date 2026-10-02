import type {
  AdminAddonService,
  AdminDiscountRule,
  AdminFileSizeServiceCharge,
  AdminPrintRate,
  ShopSettings,
} from "@printgo/api-contract";
import { indexToPickupCode } from "@printgo/domain";

export interface StoredPrintRate extends AdminPrintRate {
  id: string;
}

export interface StoredFileSizeServiceCharge extends AdminFileSizeServiceCharge {
  id: string;
  enabled: boolean;
  sortOrder: number;
}

export interface StoredPricingConfiguration {
  printRates: StoredPrintRate[];
  fileSizeServiceCharges: StoredFileSizeServiceCharge[];
  addonServices?: AdminAddonService[];
  priorityPrinting?: {
    enabled: boolean;
    feePaise: number;
  };
  discountRules?: AdminDiscountRule[];
}

export interface ConfigurationRepository {
  getSettings(): Promise<ShopSettings | null>;
  updateSettings(input: {
    settings: ShopSettings;
    previousOnlinePrintingEnabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<void>;
  resetPickupCode(adminId: string, nowMs: number): Promise<string>;
  getPricing(): Promise<StoredPricingConfiguration>;
  updatePricing(input: {
    printRates: AdminPrintRate[];
    fileSizeServiceCharges: AdminFileSizeServiceCharge[];
    priorityPrinting?: {
      enabled: boolean;
      feePaise: number;
    };
    adminId: string;
    nowMs: number;
  }): Promise<void>;
}

interface SettingsRow {
  logo_key: string | null;
  app_name: string;
  shop_name: string;
  contact_phone: string | null;
  address: string | null;
  customer_notice: string | null;
  online_printing_enabled: number;
  max_pdf_size_bytes: number;
  max_order_upload_bytes: number;
  identification_sheet_enabled: number;
  identification_sheet_placement: "FIRST" | "LAST";
  automatic_daily_cleanup_enabled: number;
  daily_cleanup_time: string;
  timezone: string;
  last_cleanup_at_ms: number | null;
  next_daily_cleanup_at_ms: number | null;
  last_cleanup_result: string | null;
  priority_printing_enabled?: number;
  priority_fee_paise?: number;
  id_requirement_mode?: "OFF" | "ALWAYS" | "ABOVE_THRESHOLD";
  id_threshold_paise?: number;
  next_pickup_code_index?: number;
}

interface PrintRateRow {
  id: string;
  paper_size: "A4" | "A3";
  color_mode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  price_per_page_paise: number;
  enabled: number;
}

interface FileSizeChargeRow {
  id: string;
  min_bytes_exclusive: number;
  max_bytes_inclusive: number;
  charge_paise: number;
  enabled: number;
  sort_order: number;
}

function auditStatement(
  db: D1Database,
  input: {
    adminId: string;
    action: string;
    entityType: string;
    entityId: string;
    nowMs: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_logs
       (id, actor_type, actor_id, action, entity_type, entity_id, created_at_ms)
       VALUES (?, 'ADMIN', ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.adminId,
      input.action,
      input.entityType,
      input.entityId,
      input.nowMs,
    );
}

export class D1ConfigurationRepository implements ConfigurationRepository {
  constructor(private readonly db: D1Database) {}

  async getSettings(): Promise<ShopSettings | null> {
    const row = await this.db
      .prepare(
        `SELECT logo_key, app_name, shop_name, contact_phone, address, customer_notice,
                online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
                identification_sheet_enabled, identification_sheet_placement,
                automatic_daily_cleanup_enabled, daily_cleanup_time, timezone,
                last_cleanup_at_ms, next_daily_cleanup_at_ms, last_cleanup_result,
                priority_printing_enabled, priority_fee_paise,
                id_requirement_mode, id_threshold_paise, next_pickup_code_index
         FROM installation WHERE id = 1`,
      )
      .first<SettingsRow>();
    return row
      ? {
          appName: row.app_name,
          shopName: row.shop_name,
          logoUrl: row.logo_key
            ? `/api/branding/logo/${row.logo_key.slice("branding/".length)}`
            : null,
          contactPhone: row.contact_phone,
          address: row.address,
          customerNotice: row.customer_notice,
          onlinePrintingEnabled: row.online_printing_enabled === 1,
          maxPdfSizeBytes: row.max_pdf_size_bytes,
          maxOrderUploadBytes: row.max_order_upload_bytes,
          identificationSheetEnabled: row.identification_sheet_enabled === 1,
          identificationSheetPlacement: row.identification_sheet_placement,
          automaticDailyCleanupEnabled:
            row.automatic_daily_cleanup_enabled === 1,
          dailyCleanupTime: row.daily_cleanup_time,
          timezone: row.timezone,
          lastCleanupAt: row.last_cleanup_at_ms
            ? new Date(row.last_cleanup_at_ms).toISOString()
            : null,
          nextCleanupAt: row.next_daily_cleanup_at_ms
            ? new Date(row.next_daily_cleanup_at_ms).toISOString()
            : null,
          lastCleanupResult: row.last_cleanup_result,
          priorityPrintingEnabled: row.priority_printing_enabled === 1,
          priorityFeePaise: row.priority_fee_paise ?? 0,
          idRequirementMode: row.id_requirement_mode ?? "OFF",
          idThresholdPaise: row.id_threshold_paise ?? 0,
          nextPickupCode: indexToPickupCode(row.next_pickup_code_index ?? 0),
        }
      : null;
  }

  async updateSettings(input: {
    settings: ShopSettings;
    previousOnlinePrintingEnabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `UPDATE installation
           SET app_name = ?, shop_name = ?, contact_phone = ?, address = ?, customer_notice = ?,
               online_printing_enabled = ?, max_pdf_size_bytes = ?, max_order_upload_bytes = ?,
               identification_sheet_enabled = ?, identification_sheet_placement = ?,
               next_daily_cleanup_at_ms = CASE
                 WHEN automatic_daily_cleanup_enabled = ? AND daily_cleanup_time = ? AND timezone = ?
                 THEN next_daily_cleanup_at_ms ELSE NULL END,
               automatic_daily_cleanup_enabled = ?, daily_cleanup_time = ?, timezone = ?,
               priority_printing_enabled = COALESCE(?, priority_printing_enabled),
               priority_fee_paise = COALESCE(?, priority_fee_paise),
               id_requirement_mode = COALESCE(?, id_requirement_mode),
               id_threshold_paise = COALESCE(?, id_threshold_paise),
               updated_at_ms = ?
           WHERE id = 1`,
        )
        .bind(
          input.settings.appName ?? "PrintGo",
          input.settings.shopName,
          input.settings.contactPhone,
          input.settings.address,
          input.settings.customerNotice,
          input.settings.onlinePrintingEnabled ? 1 : 0,
          input.settings.maxPdfSizeBytes,
          input.settings.maxOrderUploadBytes ?? input.settings.maxPdfSizeBytes,
          input.settings.identificationSheetEnabled ? 1 : 0,
          input.settings.identificationSheetPlacement,
          input.settings.automaticDailyCleanupEnabled ? 1 : 0,
          input.settings.dailyCleanupTime ?? "23:30",
          input.settings.timezone ?? "Asia/Kolkata",
          input.settings.automaticDailyCleanupEnabled ? 1 : 0,
          input.settings.dailyCleanupTime ?? "23:30",
          input.settings.timezone ?? "Asia/Kolkata",
          input.settings.priorityPrintingEnabled !== undefined
            ? input.settings.priorityPrintingEnabled
              ? 1
              : 0
            : null,
          input.settings.priorityFeePaise !== undefined
            ? input.settings.priorityFeePaise
            : null,
          input.settings.idRequirementMode !== undefined
            ? input.settings.idRequirementMode
            : null,
          input.settings.idThresholdPaise !== undefined
            ? input.settings.idThresholdPaise
            : null,
          input.nowMs,
        ),
      auditStatement(this.db, {
        adminId: input.adminId,
        action: "SHOP_SETTINGS_UPDATED",
        entityType: "INSTALLATION",
        entityId: "1",
        nowMs: input.nowMs,
      }),
    ];
    if (
      input.previousOnlinePrintingEnabled !==
      input.settings.onlinePrintingEnabled
    ) {
      statements.push(
        auditStatement(this.db, {
          adminId: input.adminId,
          action: input.settings.onlinePrintingEnabled
            ? "ONLINE_PRINTING_ENABLED"
            : "ONLINE_PRINTING_DISABLED",
          entityType: "INSTALLATION",
          entityId: "1",
          nowMs: input.nowMs,
        }),
      );
    }
    await this.db.batch(statements);
  }

  async resetPickupCode(adminId: string, nowMs: number): Promise<string> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE installation SET next_pickup_code_index = 0, updated_at_ms = ? WHERE id = 1`,
        )
        .bind(nowMs),
      auditStatement(this.db, {
        adminId,
        action: "RESET_PICKUP_CODE_SEQUENCE",
        entityType: "INSTALLATION",
        entityId: "1",
        nowMs,
      }),
    ]);
    return "PA-001";
  }

  async getPricing(): Promise<StoredPricingConfiguration> {
    const [
      rateResult,
      chargeResult,
      installResult,
      discountResult,
      addonResult,
    ] = await this.db.batch([
      this.db.prepare(
        `SELECT id, paper_size, color_mode, sides, price_per_page_paise, enabled
           FROM print_rates
           ORDER BY paper_size DESC, color_mode, sides DESC`,
      ),
      this.db.prepare(
        `SELECT id, min_bytes_exclusive, max_bytes_inclusive, charge_paise,
                  enabled, sort_order
           FROM file_size_service_charges
           ORDER BY sort_order`,
      ),
      this.db.prepare(
        `SELECT priority_printing_enabled, priority_fee_paise
           FROM installation WHERE id = 1`,
      ),
      this.db.prepare(
        `SELECT id, min_subtotal_paise, discount_percent, enabled, created_at_ms, updated_at_ms
           FROM discount_rules
           ORDER BY min_subtotal_paise ASC`,
      ),
      this.db.prepare(
        `SELECT id, name, pricing_type, fixed_price_paise, handling_mode, enabled, display_order, created_at_ms, updated_at_ms
           FROM addon_services
           ORDER BY display_order ASC, name ASC`,
      ),
    ]);
    if (!rateResult || !chargeResult) {
      throw new Error("Pricing configuration could not be loaded.");
    }
    const installRow = installResult?.results?.[0] as
      | { priority_printing_enabled: number; priority_fee_paise: number }
      | undefined;
    const discountRows = (discountResult?.results ?? []) as Array<{
      id: string;
      min_subtotal_paise: number;
      discount_percent: number;
      enabled: number;
      created_at_ms: number;
      updated_at_ms: number;
    }>;
    const addonRows = (addonResult?.results ?? []) as Array<{
      id: string;
      name: string;
      pricing_type: "FIXED_PRICE" | "STAFF_PRICED";
      fixed_price_paise: number | null;
      handling_mode: "AUTO" | "POST_PRINT" | "MANUAL_PRINT";
      enabled: number;
      display_order: number;
      created_at_ms: number;
      updated_at_ms: number;
    }>;

    return {
      printRates: (rateResult.results as unknown as PrintRateRow[]).map(
        (row) => ({
          id: row.id,
          paperSize: row.paper_size,
          colorMode: row.color_mode,
          sides: row.sides,
          pricePerPagePaise: row.price_per_page_paise,
          enabled: row.enabled === 1,
        }),
      ),
      fileSizeServiceCharges: (
        chargeResult.results as unknown as FileSizeChargeRow[]
      ).map((row) => ({
        id: row.id,
        minBytesExclusive: row.min_bytes_exclusive,
        maxBytesInclusive: row.max_bytes_inclusive,
        chargePaise: row.charge_paise,
        enabled: row.enabled === 1,
        sortOrder: row.sort_order,
      })),
      addonServices: addonRows.map((r) => ({
        id: r.id,
        name: r.name,
        pricingType: r.pricing_type,
        fixedPricePaise: r.fixed_price_paise,
        handlingMode: r.handling_mode,
        enabled: r.enabled === 1,
        displayOrder: r.display_order,
        createdAt: new Date(r.created_at_ms).toISOString(),
        updatedAt: new Date(r.updated_at_ms).toISOString(),
      })),
      priorityPrinting: {
        enabled: (installRow?.priority_printing_enabled ?? 0) === 1,
        feePaise: installRow?.priority_fee_paise ?? 0,
      },
      discountRules: discountRows.map((r) => ({
        id: r.id,
        minSubtotalPaise: r.min_subtotal_paise,
        discountPercent: r.discount_percent,
        enabled: r.enabled === 1,
        createdAt: new Date(r.created_at_ms).toISOString(),
        updatedAt: new Date(r.updated_at_ms).toISOString(),
      })),
    };
  }

  async updatePricing(input: {
    printRates: AdminPrintRate[];
    fileSizeServiceCharges: AdminFileSizeServiceCharge[];
    priorityPrinting?: {
      enabled: boolean;
      feePaise: number;
    };
    adminId: string;
    nowMs: number;
  }): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    for (const rate of input.printRates) {
      statements.push(
        this.db
          .prepare(
            `UPDATE print_rates
             SET price_per_page_paise = ?, enabled = ?, updated_at_ms = ?
             WHERE paper_size = ? AND color_mode = ? AND sides = ?`,
          )
          .bind(
            rate.pricePerPagePaise,
            rate.enabled ? 1 : 0,
            input.nowMs,
            rate.paperSize,
            rate.colorMode,
            rate.sides,
          ),
      );
    }
    for (const charge of input.fileSizeServiceCharges) {
      statements.push(
        this.db
          .prepare(
            `UPDATE file_size_service_charges
             SET charge_paise = ?, enabled = 1, updated_at_ms = ?
             WHERE min_bytes_exclusive = ? AND max_bytes_inclusive = ?`,
          )
          .bind(
            charge.chargePaise,
            input.nowMs,
            charge.minBytesExclusive,
            charge.maxBytesInclusive,
          ),
      );
    }
    if (input.priorityPrinting) {
      statements.push(
        this.db
          .prepare(
            `UPDATE installation
             SET priority_printing_enabled = ?, priority_fee_paise = ?, updated_at_ms = ?
             WHERE id = 1`,
          )
          .bind(
            input.priorityPrinting.enabled ? 1 : 0,
            input.priorityPrinting.feePaise,
            input.nowMs,
          ),
      );
    }
    statements.push(
      auditStatement(this.db, {
        adminId: input.adminId,
        action: "PRICING_UPDATED",
        entityType: "PRICING_CONFIGURATION",
        entityId: "current",
        nowMs: input.nowMs,
      }),
    );
    await this.db.batch(statements);
  }
}
