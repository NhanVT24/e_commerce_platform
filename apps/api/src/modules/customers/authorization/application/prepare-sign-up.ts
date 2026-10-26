import type { SignUpPolicy } from "../domain/sign-up-policy.js";
import { SignUpEmail } from "../domain/sign-up-email.js";
export class PrepareSignUp {
    constructor(private readonly policy: SignUpPolicy, private readonly users: {
        unique(): Promise<void>;
        link(): Promise<void>;
    }, private readonly options: {
        confirmNative: boolean;
        verifyNative: boolean;
    }) { }
    async execute(email: string, source: "external" | "native" | "other") {
        new SignUpEmail(email).assertAllowedBy(this.policy);
        if (source === "external") {
            await this.users.link();
            return { autoConfirmUser: true, autoVerifyEmail: true };
        }
        if (source === "native") {
            await this.users.unique();
            return { ...(this.options.confirmNative ? { autoConfirmUser: true } : {}), ...(this.options.verifyNative ? { autoVerifyEmail: true } : {}) };
        }
        return {};
    }
}
