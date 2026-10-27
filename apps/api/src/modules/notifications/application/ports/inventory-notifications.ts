export type InventoryEffects = Record<"notification" | "audit" | "sns", "SUCCEEDED" | "UNKNOWN" | "SKIPPED">;
import type { Notification, NewNotificationSnapshot } from "../../domain/notification.js";
export interface InventoryNotificationClaim { created: boolean; notificationId: string; owner: string; }
export interface InventoryNotifications {
  notificationId(eventId: string, email: string): string;
  /** Receipt and notification are created atomically; the receipt survives deletion. */
  createOnce(input: { eventId: string; notification: Notification<NewNotificationSnapshot> }): Promise<InventoryNotificationClaim>;
  /** External effects are attempted at most once per receipt. IN_PROGRESS after a
   * crash is ambiguous and requires review; no automatic lease takeover/resend. */
  finish(input: InventoryNotificationClaim & { eventId: string; email: string; effects: InventoryEffects }): Promise<void>;
}
