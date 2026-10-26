import type { InventoryStockAlert } from "./inventory-alert-publisher.js";

export interface DurableInventoryAlert extends InventoryStockAlert {
  eventId: string;
  productVersion: number;
  changedBy: string;
  createdAt: string;
}
export interface OutboxCandidate { eventId: string; attempts: number; }
export interface OutboxClaim extends OutboxCandidate { owner: string; event: DurableInventoryAlert; }
export interface InventoryAlertOutbox {
  due(now: string, limit: number): Promise<OutboxCandidate[]>;
  claim(candidate: OutboxCandidate, owner: string, now: string, leaseUntil: string): Promise<OutboxClaim | null>;
  published(claim: OutboxClaim, now: string): Promise<boolean>;
  retry(claim: OutboxClaim, now: string, nextAttemptAt: string, exhausted: boolean): Promise<boolean>;
}
export interface DurableInventoryAlertPublisher { publish(event: DurableInventoryAlert): Promise<void>; }
