import { BusinessError } from "../../../common/domain/business-error.js";
export interface InventoryReportDeliverySnapshot {
    reportId: string; reportDate: string; recipientEmail: string;
    lowStockCount: number; outOfStockCount: number; productCount: number;
    status: "pending"; createdAt: string; updatedAt: string;
}
export class InventoryReportDelivery {
    readonly #state: Readonly<InventoryReportDeliverySnapshot>;
    private constructor(snapshot: InventoryReportDeliverySnapshot) { this.#state = Object.freeze({ ...snapshot }); }
    toSnapshot(): InventoryReportDeliverySnapshot { return { ...this.#state }; }
    static create(report: InventoryReport, recipientEmail: string, lowStockCount: number, outOfStockCount: number, now: number): InventoryReportDelivery {
        if (!recipientEmail.trim() || ![lowStockCount, outOfStockCount, lowStockCount + outOfStockCount].every(value => Number.isSafeInteger(value) && value >= 0) ||
            !Number.isFinite(new Date(now).getTime())) throw new BusinessError("INVALID_INPUT", "Invalid inventory report delivery.");
        const timestamp = new Date(now).toISOString();
        return new InventoryReportDelivery({ reportId: report.id, reportDate: report.reportDate, recipientEmail,
            lowStockCount, outOfStockCount, productCount: lowStockCount + outOfStockCount,
            status: "pending", createdAt: timestamp, updatedAt: timestamp });
    }
}
export class InventoryReport {
    readonly reportDate: string;
    constructor(referenceDate: Date) {
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(referenceDate);
        const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        this.reportDate = `${values.year}-${values.month}-${values.day}`;
        Object.freeze(this);
    }
    get id() { return `daily-inventory-${this.reportDate}`; }
    get isScheduled() {
        const [year, month, day] = this.reportDate.split("-").map(Number);
        const elapsed = Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(2026, 0, 1)) / 86400000);
        return elapsed >= 0 && elapsed % 2 === 0;
    }
    classify<T extends {
        status: string;
    }>(products: readonly T[]) {
        return { lowStockProducts: products.filter(product => product.status === "low_stock"),
            outOfStockProducts: products.filter(product => product.status === "out_of_stock") };
    }
}
