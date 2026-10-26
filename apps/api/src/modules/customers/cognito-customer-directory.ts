import { CognitoIdentityProviderClient, ListUsersCommand, type AttributeType } from "@aws-sdk/client-cognito-identity-provider";
import { awsConfig } from "../../config/aws-config.js";
import { identityConfig } from "../../config/identity-config.js";

const cognito = new CognitoIdentityProviderClient({ region: awsConfig.AWS_REGION });

function attribute(attributes: AttributeType[] | undefined, name: string) {
  return attributes?.find((item) => item.Name === name)?.Value?.trim() ?? "";
}

function escapeFilterValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}


export async function searchCustomerCandidates(search: string, limit: number) {
 if(!identityConfig.COGNITO_USER_POOL_ID) throw new Error("Missing COGNITO_USER_POOL_ID configuration.");
  const filters = search
    ? [`email ^= "${escapeFilterValue(search)}"`, `name ^= "${escapeFilterValue(search)}"`]
    : [undefined];

  const pages = await Promise.all(filters.map((Filter) => cognito.send(new ListUsersCommand({
    UserPoolId: identityConfig.COGNITO_USER_POOL_ID,
    Filter,
    // Cognito can return unverified accounts too, so request a little extra
    // before filtering them out locally.
    Limit: Math.min(Math.max(limit * 2, 25), 60)
  }))));


 return pages.flatMap(page => page.Users ?? []).map(user => ({ email: attribute(user.Attributes,"email"),
 displayName: attribute(user.Attributes,"name"), enabled: Boolean(user.Enabled), emailVerified: attribute(user.Attributes,"email_verified").toLowerCase() === "true" }));
}
