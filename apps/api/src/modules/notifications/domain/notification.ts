import { BusinessError } from "../../../common/domain/business-error.js";
export interface NotificationSnapshot {
    id: string;
    customerEmail: string;
    isRead: boolean;
    metadata?: Record<string, unknown>;
}
export interface NewNotificationSnapshot extends NotificationSnapshot {
    title: string;
    message: string;
    channel: "email" | "system";
    status: "pending";
    createdAt: string;
    updatedAt: string;
}
export class Notification<T extends NotificationSnapshot = NotificationSnapshot> {
    readonly #state: Readonly<T>;
    constructor(snapshot: T) {
        this.#state = Object.freeze({ ...snapshot, metadata: snapshot.metadata ? { ...snapshot.metadata } : undefined });
    }
    get isUnread() { return !this.#state.isRead; }
    toSnapshot(): T {
        return { ...this.#state, metadata: this.#state.metadata ? { ...this.#state.metadata } : undefined };
    }
    static create(input: { id: string; email: string; title: string; message: string; channel: "email" | "system";
        metadata?: Record<string, unknown> }, now: number): Notification<NewNotificationSnapshot> {
        Notification.assertSystemChannel(input.channel);
        if (!input.id.trim() || !input.email.trim() || !input.title.trim() || !input.message.trim() || !Number.isFinite(new Date(now).getTime())) {
            throw new BusinessError("INVALID_INPUT", "Invalid notification.");
        }
        const timestamp = new Date(now).toISOString();
        return new Notification({ id: input.id, customerEmail: input.email, title: input.title, message: input.message,
            channel: input.channel, metadata: input.metadata, status: "pending", isRead: false, createdAt: timestamp, updatedAt: timestamp });
    }
    isVisibleToAdmin(email: string, configuredEmail?: string) {
        const adminEmails = new Set([email, String(configuredEmail ?? "").trim().toLowerCase()].filter(Boolean));
        const audience = String(this.#state.metadata?.audience ?? "").trim().toLowerCase();
        return audience === "admin" || adminEmails.has(String(this.#state.customerEmail ?? "").trim().toLowerCase());
    }
    static assertSystemChannel(channel: "system" | "email") {
        if (channel === "email")
            throw new Error("Email delivery must be queued through the email route, not createPendingNotification.");
    }
}
