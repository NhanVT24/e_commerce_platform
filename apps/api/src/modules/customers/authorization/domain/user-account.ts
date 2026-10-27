import { BusinessError } from "../../../../common/domain/business-error.js";
import type { UserAccountStatus } from "./account-status.js";
import { isProductPermission, type ProductPermission } from "../../../../common/domain/product-permissions.js";
export class UserPermissionChange {
    constructor(readonly subject: string, readonly permission: ProductPermission, readonly actor: string) {
        if (!subject.trim() || !actor.trim() || !isProductPermission(permission)) {
            throw new BusinessError("INVALID_INPUT", "Invalid user permission change.");
        }
        Object.freeze(this);
    }
}
export interface UserAccountSnapshot {
    subject: string;
    status: unknown;
}
export class UserAccount {
    readonly subject: string;
    readonly status: UserAccountStatus;
    constructor(snapshot: UserAccountSnapshot) {
        this.subject = snapshot.subject;
        this.status = UserAccount.normalizeStatus(snapshot.status);
        Object.freeze(this);
    }
    static normalizeStatus(status: unknown): UserAccountStatus {
        const value = String(status || "").trim().toUpperCase();
        return value === "SUSPENDED" || value === "DISABLED" || value === "BLOCKED" ? value : "ACTIVE";
    }
    get canSignIn() { return this.status === "ACTIVE"; }
    assertCanSignIn(): void {
        if (!this.canSignIn)
            throw new Error("This account is not allowed to sign in. Please contact support.");
    }
    assertCanReceiveTokens(): void {
        if (!this.canSignIn)
            throw new Error("This account is not allowed to receive new tokens. Please contact support.");
    }
    statusChangedBy(actorSubject: string, status: unknown): UserAccount {
        const next = new UserAccount({ subject: this.subject, status });
        if (this.subject === actorSubject && !next.canSignIn) {
            throw new BusinessError("INVALID_INPUT", "You cannot block your own account.");
        }
        return next;
    }
    identityClaims(input: {
        groups: string[];
        email: string;
        displayName: string;
        provider: string;
    }) {
        return { role: input.groups.includes("admin") ? "admin" : "customer", auth_provider: input.provider,
            principal_email: input.email, display_name: input.displayName, account_status: this.status };
    }
}
