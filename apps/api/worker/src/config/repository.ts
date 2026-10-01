import type {
  AdminFileSizeServiceCharge,
  AdminPrintRate,
  ShopSettings,
} from "@printgo/api-contract";

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
}

export interface ConfigurationRepository {
  getSettings(): Promise<ShopSettings | null>;
  updateSettings(input: {
    settings: ShopSettings;
    previousOnlinePrintingEnabled: boolean;
    adminId: string;
    nowMs: number;
  }): Promise<void>;
  getPricing(): Promise<StoredPricingConfiguration>;
  updatePricing(input: {
    printRates: AdminPrintRate[];
    fileSizeServiceCharges: AdminFileSizeServiceCharge[];
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
                last_cleanup_at_ms, next_daily_cleanup_at_ms, last_cleanup_result
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

  async getPricing(): Promise<StoredPricingConfiguration> {
    const [rateResult, chargeResult] = await this.db.batch([
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
    ]);
    if (!rateResult || !chargeResult) {
      throw new Error("Pricing configuration could not be loaded.");
    }
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
    };
  }

  async updatePricing(input: {
    printRates: AdminPrintRate[];
    fileSizeServiceCharges: AdminFileSizeServiceCharge[];
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
