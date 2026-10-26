import { CognitoJwtVerifier } from "aws-jwt-verify";
import { identityConfig } from "../../config/identity-config.js";
import { normalizePermissions, type ProductPermission } from "./permissions.js";

type JwtPayload = {
  sub?: string;
  email?: string;
  principal_email?: string;
  role?: string;
  account_status?: string;
  "cognito:groups"?: string | string[];
  permissions?: unknown;
};

const verifier = identityConfig.COGNITO_USER_POOL_ID && identityConfig.COGNITO_CLIENT_ID
  ? CognitoJwtVerifier.create({
      userPoolId: identityConfig.COGNITO_USER_POOL_ID,
      clientId: identityConfig.COGNITO_CLIENT_ID,
      tokenUse: "access"
    })
  : null;

function toGroups(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return [];
}

function decodeUnverifiedTestPayload(token: string): JwtPayload | null {
  if (!identityConfig.AUTH_ALLOW_UNVERIFIED_JWT) return null;
  try {
    const [, encodedPayload = ""] = token.split(".");
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as JwtPayload;
  } catch {
    return null;
  }
}

export type CognitoPrincipal = {
  subject: string;
  email: string;
  role: "admin" | "customer" | "viewer";
  accountStatus: "ACTIVE" | "SUSPENDED" | "DISABLED" | "BLOCKED";
  groups: string[];
  permissions: ProductPermission[];
};

export function hasPermission(principal: CognitoPrincipal, permission: ProductPermission) {
  return principal.role === "admin" || principal.permissions.includes(permission);
}

export async function extractCognitoPrincipal(headers: Record<string, unknown>): Promise<CognitoPrincipal | null> {
  const authorization = headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  try {
    const payload = identityConfig.AUTH_ALLOW_UNVERIFIED_JWT
      ? decodeUnverifiedTestPayload(token)
      : verifier
        ? await verifier.verify(token) as JwtPayload
        : null;
    if (!payload) return null;
    const groups = toGroups(payload["cognito:groups"]);
    const role = String(payload.role || "").toLowerCase();
    const resolvedRole: CognitoPrincipal["role"] =
      role === "admin" || groups.includes("admin")
        ? "admin"
        : role === "customer" || groups.includes("customer")
          ? "customer"
          : "viewer";
    const subject = String(payload.sub || "").trim();
    const email = String(payload.principal_email || payload.email || "").trim().toLowerCase();
    const accountStatus = String(payload.account_status || "ACTIVE").trim().toUpperCase();
    if (!subject || !email) return null;
    if (accountStatus === "SUSPENDED" || accountStatus === "DISABLED" || accountStatus === "BLOCKED") return null;

    return {
      subject,
      email,
      role: resolvedRole,
      accountStatus: accountStatus === "SUSPENDED" || accountStatus === "DISABLED" || accountStatus === "BLOCKED" ? accountStatus : "ACTIVE",
      groups,
      permissions: normalizePermissions(payload.permissions)
    };
  } catch {
    return null;
  }
}
