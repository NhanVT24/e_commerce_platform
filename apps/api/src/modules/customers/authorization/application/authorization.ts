import { UserAccount, UserPermissionChange } from "../domain/user-account.js";
import { ProfileChange } from "../domain/user-profile.js";
import { ApplicationError } from "../../../../common/application/application-error.js";
import type { ProductPermission } from "../../../../common/domain/product-permissions.js";
import { type UserAccountStatus } from "../domain/account-status.js";
import type { UserAddress } from "../domain/user-address.js";
export interface DirectoryUser {
    subject: string;
    username: string;
    email: string;
    displayName: string;
}
export interface UserDirectory {
    listUsers(): Promise<DirectoryUser[]>;
}
export interface AuthorizationStore {
    getUserProfileSummary(subject: string): Promise<{
        accountStatus: UserAccountStatus;
        lastLoginAt: string;
        displayName: string;
        addresses: UserAddress[];
    }>;
    getUserPermissions(subject: string): Promise<ProductPermission[]>;
    addUserPermission(change: UserPermissionChange): Promise<ProductPermission[]>;
    removeUserPermission(change: UserPermissionChange): Promise<ProductPermission[]>;
    updateUserAccountStatus(account: UserAccount, actor: string): Promise<UserAccountStatus>;
    updateUserAddresses(change: ProfileChange, actor: string): Promise<UserAddress[]>;
}
export class AuthorizationUseCases {
    constructor(private readonly directory: UserDirectory, private readonly store: AuthorizationStore) { }
    async listUsers() {
        const users = await this.listCognitoUsers();
        return Promise.all(users.map(async (user) => {
            const [profile, permissions] = await Promise.all([
                this.store.getUserProfileSummary(user.subject),
                this.store.getUserPermissions(user.subject)
            ]);
            return {
                ...user,
                ...profile,
                displayName: profile.displayName || user.displayName,
                permissions
            };
        }));
    }
    private listCognitoUsers() { return this.directory.listUsers(); }
    async addPermission(subject: string, permission: ProductPermission, actorSubject: string) {
        await this.assertUserExists(subject);
        return { subject, permissions: await this.store.addUserPermission(new UserPermissionChange(subject, permission, actorSubject)) };
    }
    async removePermission(subject: string, permission: ProductPermission, actorSubject: string) {
        await this.assertUserExists(subject);
        return { subject, permissions: await this.store.removeUserPermission(new UserPermissionChange(subject, permission, actorSubject)) };
    }
    async updateAccountStatus(subject: string, status: UserAccountStatus, actorSubject: string) {
        await this.assertUserExists(subject);
        const account = new UserAccount({ subject, status }).statusChangedBy(actorSubject, status);
        return { subject, accountStatus: await this.store.updateUserAccountStatus(account, actorSubject) };
    }
    async updateAddresses(subject: string, addresses: UserAddress[], actorSubject: string) {
        await this.assertUserExists(subject);
        const change = new ProfileChange(subject, { addresses });
        change.assertAllowed();
        return { subject, addresses: await this.store.updateUserAddresses(change, actorSubject) };
    }
    private async assertUserExists(subject: string) {
        const users = await this.listCognitoUsers();
        if (!users.some((user) => user.subject === subject)) {
            throw new ApplicationError("NOT_FOUND", "Cognito user not found");
        }
    }
}
