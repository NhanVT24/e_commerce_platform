export type InventoryEffects = Record<"notification" | "audit" | "sns", "SUCCEEDED" | "UNKNOWN" | "SKIPPED">;
export interface InventoryNotificationClaim { created: boolean; notificationId: string; owner: string; }
export interface InventoryNotifications {
  /** Receipt and notification are created atomically; the receipt survives deletion. */
  createOnce(input: { eventId: string; email: string; title: string; message: string; metadata: Record<string, unknown> }): Promise<InventoryNotificationClaim>;
  /** External effects are attempted at most once per receipt. IN_PROGRESS after a
   * crash is ambiguous and requires review; no automatic lease takeover/resend. */
  finish(input: InventoryNotificationClaim & { eventId: string; email: string; effects: InventoryEffects }): Promise<void>;
}
