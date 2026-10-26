import { SignUpEmail } from "./sign-up-email.js";
export interface SignUpPolicy {
    allowedDomains: string[];
    blockedDomains: string[];
    blockedEmails: string[];
}
export function assertSignUpEmail(email: string, policy: SignUpPolicy) { new SignUpEmail(email).assertAllowedBy(policy); }
