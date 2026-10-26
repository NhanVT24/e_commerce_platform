import { CognitoIdentityProviderClient, ListUsersCommand, type AttributeType } from "@aws-sdk/client-cognito-identity-provider";
import { awsConfig } from "../../../../config/aws-config.js";
import { identityConfig } from "../../../../config/identity-config.js";
import * as store from "../authorization.repository.js";
import type { UserDirectory, AuthorizationStore } from "../application/authorization.js";
const cognito = new CognitoIdentityProviderClient({ region: awsConfig.AWS_REGION });
function attribute(attributes: AttributeType[] | undefined, name: string) { return attributes?.find(item => item.Name === name)?.Value?.trim() ?? ""; }
export class CognitoUserDirectory implements UserDirectory {
    async listUsers() {
        if (!identityConfig.COGNITO_USER_POOL_ID)
            throw new Error("Missing COGNITO_USER_POOL_ID configuration.");
        const response = await cognito.send(new ListUsersCommand({
            UserPoolId: identityConfig.COGNITO_USER_POOL_ID,
            Limit: 60
        }));
        return (response.Users ?? [])
            .filter((user) => user.Enabled && attribute(user.Attributes, "sub"))
            .map((user) => ({
            subject: attribute(user.Attributes, "sub"),
            username: String(user.Username ?? ""),
            email: attribute(user.Attributes, "email").toLowerCase(),
            displayName: attribute(user.Attributes, "name") || attribute(user.Attributes, "email")
        }));
    }
}
export const dynamoAuthorizationStore: AuthorizationStore = {
    getUserProfileSummary: store.getUserProfileSummary, getUserPermissions: store.getUserPermissions,
    addUserPermission: store.addUserPermission, removeUserPermission: store.removeUserPermission,
    updateUserAccountStatus: store.updateUserAccountStatus, updateUserAddresses: store.updateUserAddresses
};
