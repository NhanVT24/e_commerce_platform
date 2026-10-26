import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { awsConfig } from "../../../config/aws-config.js";
import { identityConfig } from "../../../config/identity-config.js";
import { getAuditLog, getAuditOrderEmails, listAuditLogs } from "../audit-log.repository.js";
import type { AuditReadPort } from "../application/audit-queries.js";
import type { AuditLogRecord } from "../audit-log.js";
const cognito = new CognitoIdentityProviderClient({ region: awsConfig.AWS_REGION });
export const auditReader: AuditReadPort<AuditLogRecord> = {
    list: listAuditLogs, get: getAuditLog, orderEmails: getAuditOrderEmails,
    async userEmail(subject) {
        if (!identityConfig.COGNITO_USER_POOL_ID)
            return undefined;
        const result = await cognito.send(new ListUsersCommand({ UserPoolId: identityConfig.COGNITO_USER_POOL_ID, Filter: `sub = ${JSON.stringify(subject)}`, Limit: 1 }));
        return result.Users?.[0]?.Attributes?.find(attribute => attribute.Name === "email")?.Value;
    }
};
