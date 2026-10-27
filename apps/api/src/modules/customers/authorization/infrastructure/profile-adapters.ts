import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { awsConfig } from "../../../../config/aws-config.js";
import { databaseConfig } from "../../../../config/database-config.js";
import { storageConfig } from "../../../../config/storage-config.js";
import { rawDb } from "../../../../database/dynamodb/client.js";
import { keys } from "../../../../database/dynamodb/keys.js";
import { ApplicationError } from "../../../../common/application/application-error.js";
import { normalizeAddresses } from "../user-address.js";
import type { ProfileRepository, ProfileAvatars } from "../application/profile.js";
import type { ProfileChange } from "../domain/user-profile.js";
export class DynamoProfiles implements ProfileRepository {
    async find(subject: string) {
        const result = await rawDb.send(new GetItemCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME,
            Key: marshall(keys.userProfile(subject)), ConsistentRead: true }));
        const row = result.Item ? unmarshall(result.Item) : {};
        return { displayName: typeof row.displayName === "string" ? row.displayName : "",
            avatarKey: typeof row.avatarKey === "string" ? row.avatarKey : "", addresses: normalizeAddresses(row.addresses) };
    }
    async update(change: ProfileChange) {
        change.assertAllowed();
        const subject = change.subject;
        const patch = change.toSnapshot();
        const names: Record<string, string> = { "#updatedAt": "updatedAt", "#entityType": "entityType" };
        const values: Record<string, unknown> = { ":updatedAt": new Date().toISOString(), ":entityType": "USER_PROFILE" };
        const changes = ["#updatedAt = :updatedAt"];
        for (const field of ["displayName", "avatarKey", "addresses"] as const)
            if (patch[field] !== undefined) {
                names[`#${field}`] = field;
                values[`:${field}`] = patch[field];
                changes.push(`#${field} = :${field}`);
            }
        try {
            await rawDb.send(new UpdateItemCommand({ TableName: databaseConfig.DYNAMODB_TABLE_NAME, Key: marshall(keys.userProfile(subject)),
                UpdateExpression: `SET ${changes.join(", ")}`, ConditionExpression: "attribute_exists(PK) AND #entityType = :entityType",
                ExpressionAttributeNames: names, ExpressionAttributeValues: marshall(values) }));
        }
        catch (error) {
            if ((error as {
                name?: string;
            }).name === "ConditionalCheckFailedException")
                throw new ApplicationError("INVALID_INPUT", "User profile is not ready yet.");
            throw error;
        }
    }
}
const s3 = new S3Client({ region: awsConfig.AWS_REGION, endpoint: storageConfig.S3_ENDPOINT, forcePathStyle: storageConfig.S3_FORCE_PATH_STYLE,
    credentials: storageConfig.S3_ENDPOINT ? { accessKeyId: awsConfig.AWS_ACCESS_KEY_ID, secretAccessKey: awsConfig.AWS_SECRET_ACCESS_KEY } : undefined });
export class S3ProfileAvatars implements ProfileAvatars {
    async exists(key: string) {
        if (!storageConfig.S3_BUCKET_NAME)
            throw new ApplicationError("NOT_CONFIGURED", "Avatar storage is not configured.");
        try {
            await s3.send(new HeadObjectCommand({ Bucket: storageConfig.S3_BUCKET_NAME, Key: key }));
            return true;
        }
        catch (error) {
            const failure = error as {
                name?: string;
                $metadata?: {
                    httpStatusCode?: number;
                };
            };
            if (failure.name === "NotFound" || failure.name === "NoSuchKey" || failure.$metadata?.httpStatusCode === 404)
                return false;
            throw error;
        }
    }
    publicUrl(key: string) {
        if (!key || !storageConfig.S3_BUCKET_NAME)
            return "";
        const base = storageConfig.S3_PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? (storageConfig.S3_ENDPOINT
            ? `${storageConfig.S3_ENDPOINT.replace(/\/+$/, "")}/${storageConfig.S3_BUCKET_NAME}` : `https://${storageConfig.S3_BUCKET_NAME}.s3.${awsConfig.AWS_REGION}.amazonaws.com`);
        return `${base}/${key}`;
    }
}
