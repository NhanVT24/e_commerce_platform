import type { SignUpPolicy } from "./sign-up-policy.js";
export class SignUpEmail {
    readonly value: string;
    constructor(email: string) {
        this.value = email;
        Object.freeze(this);
    }
    assertAllowedBy(policy: SignUpPolicy): void {
        const email = this.value;
        if (!email)
            throw new Error("Email is required to create an account.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw new Error("Email is not valid.");
        const domain = email.split("@").pop()?.toLowerCase() ?? "";
        if (policy.blockedEmails.includes(email))
            throw new Error("This email cannot be used to create an account.");
        if (policy.blockedDomains.includes(domain))
            throw new Error("This email domain cannot be used to create an account.");
        if (policy.allowedDomains.length && !policy.allowedDomains.includes(domain))
            throw new Error("This email domain is not allowed to create an account.");
    }
}
