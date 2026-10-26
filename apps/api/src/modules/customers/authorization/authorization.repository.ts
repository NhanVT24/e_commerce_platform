import { normalizeAddresses, type UserAddress } from "./user-address.js";
export type { UserAddress } from "./user-address.js";
import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { databaseConfig } from "../../../config/database-config.js";
import { rawDb } from "../../../database/dynamodb/client.js";
import { keys } from "../../../database/dynamodb/keys.js";
import { normalizePermissions, type ProductPermission } from "../../../common/auth/permissions.js";

const TableName = databaseConfig.DYNAMODB_TABLE_NAME;
import { normalizeUserAccountStatus, type UserAccountStatus } from "./domain/account-status.js";
export { normalizeUserAccountStatus } from "./domain/account-status.js";
export type { UserAccountStatus } from "./domain/account-status.js";

export async function getUserPermissions(subject: string): Promise<ProductPermission[]> {
  const result = await rawDb.send(new GetItemCommand({
    TableName,
    Key: marshall(keys.userAuthorization(subject)),
    ConsistentRead: true,
    ProjectionExpression: "#permissions",
    ExpressionAttributeNames: {
      "#permissions": "permissions"
    }
  }));

  return result.Item ? normalizePermissions(unmarshall(result.Item).permissions) : [];
}

export async function getUserAccountStatus(subject: string): Promise<UserAccountStatus> {
  const result = await rawDb.send(new GetItemCommand({
    TableName,
    Key: marshall(keys.userProfile(subject)),
    ConsistentRead: true,
    ProjectionExpression: "#status",
    ExpressionAttributeNames: {
      "#status": "status"
    }
  }));

  return normalizeUserAccountStatus(result.Item ? unmarshall(result.Item).status : undefined);
}


export async function getUserProfileSummary(subject: string): Promise<{ accountStatus: UserAccountStatus; lastLoginAt: string; displayName: string; addresses: UserAddress[] }> {
  const result = await rawDb.send(new GetItemCommand({
    TableName,
    Key: marshall(keys.userProfile(subject)),
    ConsistentRead: true,
    ProjectionExpression: "#status, #lastLoginAt, #displayName, #addresses",
    ExpressionAttributeNames: {
      "#status": "status",
      "#lastLoginAt": "lastLoginAt",
      "#displayName": "displayName",
      "#addresses": "addresses"
    }
  }));

  const profile = result.Item ? unmarshall(result.Item) : {};
  return {
    accountStatus: normalizeUserAccountStatus(profile.status),
    lastLoginAt: String(profile.lastLoginAt || ""),
    displayName: String(profile.displayName || ""),
    addresses: normalizeAddresses(profile.addresses)
  };
}

export async function updateUserAccountStatus(subject: string, status: UserAccountStatus, updatedBy: string) {
  const now = new Date().toISOString();
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: marshall(keys.userProfile(subject)),
    UpdateExpression: "SET #entityType = if_not_exists(#entityType, :entityType), #subject = if_not_exists(#subject, :subject), #status = :status, #updatedAt = :updatedAt, #statusUpdatedAt = :updatedAt, #statusUpdatedBy = :updatedBy",
    ExpressionAttributeNames: {
      "#entityType": "entityType",
      "#subject": "subject",
      "#status": "status",
      "#updatedAt": "updatedAt",
      "#statusUpdatedAt": "statusUpdatedAt",
      "#statusUpdatedBy": "statusUpdatedBy"
    },
    ExpressionAttributeValues: marshall({
      ":entityType": "USER_PROFILE",
      ":subject": subject,
      ":status": status,
      ":updatedAt": now,
      ":updatedBy": updatedBy
    })
  }));

  return getUserAccountStatus(subject);
}

export async function updateUserAddresses(subject: string, addresses: UserAddress[], updatedBy: string) {
  const now = new Date().toISOString();
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: marshall(keys.userProfile(subject)),
    UpdateExpression: "SET #entityType = if_not_exists(#entityType, :entityType), #subject = if_not_exists(#subject, :subject), #addresses = :addresses, #updatedAt = :updatedAt, #updatedBy = :updatedBy",
    ExpressionAttributeNames: {
      "#entityType": "entityType",
      "#subject": "subject",
      "#addresses": "addresses",
      "#updatedAt": "updatedAt",
      "#updatedBy": "updatedBy"
    },
    ExpressionAttributeValues: marshall({
      ":entityType": "USER_PROFILE",
      ":subject": subject,
      ":addresses": addresses,
      ":updatedAt": now,
      ":updatedBy": updatedBy
    })
  }));

  return normalizeAddresses(addresses);
}

export async function addUserPermission(subject: string, permission: ProductPermission, updatedBy: string) {
  const now = new Date().toISOString();
  const key = keys.userAuthorization(subject);
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: marshall(key),
    UpdateExpression: "SET #entityType = :entityType, #subject = :subject, #updatedAt = :updatedAt, #updatedBy = :updatedBy ADD #permissions :permission",
    ExpressionAttributeNames: {
      "#entityType": "entityType",
      "#subject": "subject",
      "#updatedAt": "updatedAt",
      "#updatedBy": "updatedBy",
      "#permissions": "permissions"
    },
    ExpressionAttributeValues: marshall({
      ":entityType": "USER_AUTHORIZATION",
      ":subject": subject,
      ":updatedAt": now,
      ":updatedBy": updatedBy,
      ":permission": new Set([permission])
    }),
    ReturnValues: "ALL_NEW"
  }));

  return getUserPermissions(subject);
}

export async function removeUserPermission(subject: string, permission: ProductPermission, updatedBy: string) {
  const now = new Date().toISOString();
  const key = keys.userAuthorization(subject);
  await rawDb.send(new UpdateItemCommand({
    TableName,
    Key: marshall(key),
    UpdateExpression: "SET #updatedAt = :updatedAt, #updatedBy = :updatedBy DELETE #permissions :permission",
    ConditionExpression: "attribute_exists(PK)",
    ExpressionAttributeNames: {
      "#updatedAt": "updatedAt",
      "#updatedBy": "updatedBy",
      "#permissions": "permissions"
    },
    ExpressionAttributeValues: marshall({
      ":updatedAt": now,
      ":updatedBy": updatedBy,
      ":permission": new Set([permission])
    })
  })).catch((error: { name?: string }) => {
    if (error.name !== "ConditionalCheckFailedException") throw error;
  });

  return getUserPermissions(subject);
}
