import type {
  AdminAddonService,
  AdminAddonServiceRequest,
  HandlingMode,
  OrderAddonServiceSnapshot,
  PricingType,
} from "@printgo/api-contract";

export interface AddonServiceRepository {
  listServices(): Promise<AdminAddonService[]>;
  getService(id: string): Promise<AdminAddonService | null>;
  createService(input: AdminAddonServiceRequest): Promise<AdminAddonService>;
  updateService(
    id: string,
    input: AdminAddonServiceRequest,
  ): Promise<AdminAddonService | null>;
  deleteService(id: string): Promise<boolean>;
  toggleService(
    id: string,
    enabled: boolean,
  ): Promise<AdminAddonService | null>;
  /** Validate and resolve authoritative service config for a set of IDs. Rejects disabled/missing. */
  resolveServicesForOrder(
    serviceIds: readonly string[],
  ): Promise<AdminAddonService[]>;
  /** Snapshot selected services into order_addon_services at finalization time. */
  snapshotServicesForOrder(
    orderId: string,
    services: readonly AdminAddonService[],
  ): Promise<void>;
  /** Fetch snapshots for a given order. */
  getOrderSnapshots(orderId: string): Promise<OrderAddonServiceSnapshot[]>;
  /** Get snapshots for multiple orders in one query. */
  getOrderSnapshotsBatch(
    orderIds: readonly string[],
  ): Promise<Map<string, OrderAddonServiceSnapshot[]>>;
  /** Set staff-priced pickup charge for an order. */
  setPickupCharge(orderId: string, paise: number, nowMs: number): Promise<void>;
}

interface ServiceRow {
  id: string;
  name: string;
  pricing_type: string;
  fixed_price_paise: number;
  handling_mode: string;
  enabled: number;
  display_order: number;
}

function rowToService(row: ServiceRow): AdminAddonService {
  return {
    id: row.id,
    name: row.name,
    pricingType: row.pricing_type as PricingType,
    fixedPricePaise: row.fixed_price_paise,
    handlingMode: row.handling_mode as HandlingMode,
    enabled: row.enabled === 1,
    displayOrder: row.display_order,
  };
}

interface SnapshotRow {
  order_id: string;
  service_id: string;
  snapshot_name: string;
  snapshot_pricing_type: string;
  snapshot_price_charged_online_paise: number;
  snapshot_handling_mode: string;
}

function rowToSnapshot(row: SnapshotRow): OrderAddonServiceSnapshot {
  return {
    serviceId: row.service_id,
    serviceName: row.snapshot_name,
    pricingType: row.snapshot_pricing_type as PricingType,
    onlinePricePaise: row.snapshot_price_charged_online_paise,
    handlingMode: row.snapshot_handling_mode as HandlingMode,
  };
}

export class D1AddonServiceRepository implements AddonServiceRepository {
  constructor(private readonly db: D1Database) {}

  async listServices(): Promise<AdminAddonService[]> {
    const result = await this.db
      .prepare(
        `SELECT id, name, pricing_type, fixed_price_paise, handling_mode, enabled, display_order
         FROM addon_services ORDER BY display_order, name`,
      )
      .all<ServiceRow>();
    return result.results.map(rowToService);
  }

  async getService(id: string): Promise<AdminAddonService | null> {
    const row = await this.db
      .prepare(
        `SELECT id, name, pricing_type, fixed_price_paise, handling_mode, enabled, display_order
         FROM addon_services WHERE id = ?`,
      )
      .bind(id)
      .first<ServiceRow>();
    return row ? rowToService(row) : null;
  }

  async createService(
    input: AdminAddonServiceRequest,
  ): Promise<AdminAddonService> {
    const id = crypto.randomUUID();
    const nowMs = Date.now();
    await this.db
      .prepare(
        `INSERT INTO addon_services
           (id, name, pricing_type, fixed_price_paise, handling_mode, enabled, display_order, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.name.trim(),
        input.pricingType,
        input.pricingType === "FIXED_PRICE" ? input.fixedPricePaise : null,
        input.handlingMode,
        input.enabled ? 1 : 0,
        input.displayOrder,
        nowMs,
        nowMs,
      )
      .run();
    const created = await this.getService(id);
    if (!created) throw new Error("Failed to create add-on service.");
    return created;
  }

  async updateService(
    id: string,
    input: AdminAddonServiceRequest,
  ): Promise<AdminAddonService | null> {
    const nowMs = Date.now();
    const result = await this.db
      .prepare(
        `UPDATE addon_services
         SET name = ?, pricing_type = ?, fixed_price_paise = ?, handling_mode = ?,
             enabled = ?, display_order = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .bind(
        input.name.trim(),
        input.pricingType,
        input.pricingType === "FIXED_PRICE" ? input.fixedPricePaise : null,
        input.handlingMode,
        input.enabled ? 1 : 0,
        input.displayOrder,
        nowMs,
        id,
      )
      .run();
    if (result.meta.changes === 0) return null;
    return this.getService(id);
  }

  async deleteService(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM addon_services WHERE id = ?`)
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  async toggleService(
    id: string,
    enabled: boolean,
  ): Promise<AdminAddonService | null> {
    const nowMs = Date.now();
    const result = await this.db
      .prepare(
        `UPDATE addon_services SET enabled = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .bind(enabled ? 1 : 0, nowMs, id)
      .run();
    if (result.meta.changes === 0) return null;
    return this.getService(id);
  }

  async resolveServicesForOrder(
    serviceIds: readonly string[],
  ): Promise<AdminAddonService[]> {
    if (serviceIds.length === 0) return [];
    // Bounded: customers can select at most 10 services
    const placeholders = serviceIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT id, name, pricing_type, fixed_price_paise, handling_mode, enabled, display_order
         FROM addon_services
         WHERE id IN (${placeholders})
         ORDER BY display_order`,
      )
      .bind(...serviceIds)
      .all<ServiceRow>();
    // Reject if any requested ID is missing or disabled
    if (result.results.length !== serviceIds.length) {
      const foundIds = new Set(result.results.map((r) => r.id));
      const missing = serviceIds.find((id) => !foundIds.has(id));
      throw new AddonServiceError(
        "ADDON_SERVICE_NOT_FOUND",
        `Add-on service not found: ${missing}`,
      );
    }
    const disabled = result.results.find((r) => r.enabled === 0);
    if (disabled) {
      throw new AddonServiceError(
        "ADDON_SERVICE_DISABLED",
        `Add-on service is not currently available: ${disabled.name}`,
      );
    }
    return result.results.map(rowToService);
  }

  async snapshotServicesForOrder(
    orderId: string,
    services: readonly AdminAddonService[],
  ): Promise<void> {
    if (services.length === 0) return;
    const statements = services.map((svc) =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_addon_services
             (order_id, service_id, snapshot_name, snapshot_pricing_type,
              snapshot_price_charged_online_paise, snapshot_handling_mode)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          orderId,
          svc.id,
          svc.name,
          svc.pricingType,
          svc.pricingType === "FIXED_PRICE" ? svc.fixedPricePaise : 0,
          svc.handlingMode,
        ),
    );
    await this.db.batch(statements);
  }

  async getOrderSnapshots(
    orderId: string,
  ): Promise<OrderAddonServiceSnapshot[]> {
    const result = await this.db
      .prepare(
        `SELECT order_id, service_id, snapshot_name, snapshot_pricing_type,
                snapshot_price_charged_online_paise, snapshot_handling_mode
         FROM order_addon_services WHERE order_id = ?
         ORDER BY rowid`,
      )
      .bind(orderId)
      .all<SnapshotRow>();
    return result.results.map(rowToSnapshot);
  }

  async getOrderSnapshotsBatch(
    orderIds: readonly string[],
  ): Promise<Map<string, OrderAddonServiceSnapshot[]>> {
    if (orderIds.length === 0) return new Map();
    const placeholders = orderIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT order_id, service_id, snapshot_name, snapshot_pricing_type,
                snapshot_price_charged_online_paise, snapshot_handling_mode
         FROM order_addon_services WHERE order_id IN (${placeholders})
         ORDER BY order_id, rowid`,
      )
      .bind(...orderIds)
      .all<SnapshotRow>();
    const map = new Map<string, OrderAddonServiceSnapshot[]>();
    for (const row of result.results) {
      const list = map.get(row.order_id) ?? [];
      list.push(rowToSnapshot(row));
      map.set(row.order_id, list);
    }
    return map;
  }

  async setPickupCharge(
    orderId: string,
    paise: number,
    nowMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE orders SET due_at_pickup_paise = ?, updated_at_ms = ?
         WHERE id = ? AND status IN ('MANUAL_PRINT', 'AWAITING_FINISHING', 'PRINTED')`,
      )
      .bind(paise, nowMs, orderId)
      .run();
  }
}

export class AddonServiceError extends Error {
  constructor(
    readonly code: "ADDON_SERVICE_NOT_FOUND" | "ADDON_SERVICE_DISABLED",
    message: string,
  ) {
    super(message);
    this.name = "AddonServiceError";
  }
}
