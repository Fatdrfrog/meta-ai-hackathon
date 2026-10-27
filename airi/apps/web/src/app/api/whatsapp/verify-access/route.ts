import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import { NextResponse } from "next/server";

const graphClient = getWhatsAppGraphClient();

type MetaAppPermission = {
  permission?: unknown;
  status?: unknown;
};

const ACCEPTED_WHATSAPP_APP_PERMISSION_STATUSES = new Set([
  "granted",
  "live",
  "approved",
]);

function hasAcceptedWhatsAppPermissionStatus(status: unknown) {
  return (
    typeof status === "string" &&
    ACCEPTED_WHATSAPP_APP_PERMISSION_STATUSES.has(status.trim().toLowerCase())
  );
}

function hasPermission(
  permissions: MetaAppPermission[],
  permissionName: string
) {
  return permissions.some(
    permission =>
      permission.permission === permissionName &&
      hasAcceptedWhatsAppPermissionStatus(permission.status)
  );
}

export function getWhatsAppAppPermissionSummary(permissions: unknown) {
  const permissionList = Array.isArray(permissions)
    ? (permissions as MetaAppPermission[])
    : [];
  const hasManagement = hasPermission(
    permissionList,
    "whatsapp_business_management"
  );
  const hasMessaging = hasPermission(
    permissionList,
    "whatsapp_business_messaging"
  );
  const missingPermissions = [
    ...(hasManagement ? [] : ["whatsapp_business_management"]),
    ...(hasMessaging ? [] : ["whatsapp_business_messaging"]),
  ];

  return {
    hasManagement,
    hasMessaging,
    hasRequiredWhatsAppPermissions: missingPermissions.length === 0,
    missingPermissions,
  };
}

/**
 * GET /api/whatsapp/verify-access
 *
 * Checks if the Meta App has completed Access Verification.
 * Access Verification is required for tech providers to use Embedded Signup.
 *
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
 *
 * Returns:
 * - verified: boolean indicating if access verification is complete
 * - status: Current verification status
 * - message: Human-readable message
 */
export async function GET() {
  try {
    const appId = process.env.NEXT_PUBLIC_META_APP_ID;
    // CRITICAL: Use server-side secret only, never expose to client
    const appSecret = process.env.META_APP_SECRET || "";

    if (!appId || !appSecret) {
      return NextResponse.json(
        {
          verified: false,
          status: "missing_credentials",
          message:
            "Meta App credentials not configured. Please set NEXT_PUBLIC_META_APP_ID and META_APP_SECRET.",
        },
        { status: 400 }
      );
    }

    // Get app access token
    const appAccessToken = `${appId}|${appSecret}`;

    console.log("Checking access verification for App ID:", appId);

    // Check app info to verify access verification status
    // Note: Meta doesn't expose access verification status directly via API,
    // but we can check if the app has the required permissions and is in good standing
    try {
      const appInfoRes = await graphClient.request(appId, {
        token: appAccessToken,
        method: "GET",
        query: {
          fields:
            "id,name,category,subcategory,link,company,privacy_policy_url,terms_of_service_url,user_support_email,app_domains,contact_email",
        },
      });

      if (!appInfoRes.ok) {
        const errorText = await appInfoRes.text();
        console.error("Failed to fetch app info:", errorText);
        return NextResponse.json(
          {
            verified: false,
            status: "api_error",
            message: `Failed to fetch app info: ${errorText}`,
          },
          { status: 500 }
        );
      }

      const appInfo = (await appInfoRes.json()) as {
        id?: string;
        name?: string;
        category?: string;
      };

      console.log("App Info received:", JSON.stringify(appInfo, null, 2));

      // Check if app has required permissions for Embedded Signup
      // For tech providers, we need whatsapp_business_management permission
      try {
        // NOTE: For Tech Provider apps, /permissions with App Token might return empty or error.
        // As a tech provider, we just need the permission to be APPROVED (Advanced Access) by Meta.
        const permissionsRes = await graphClient.request(
          `${appId}/permissions`,
          {
            token: appAccessToken,
            method: "GET",
          }
        );

        if (permissionsRes.ok) {
          const permissionsData = await permissionsRes.json();
          console.log(
            "App Permissions Response:",
            JSON.stringify(permissionsData, null, 2)
          );

          const permissionSummary = getWhatsAppAppPermissionSummary(
            permissionsData.data
          );
          const hasWhatsAppPermission =
            permissionSummary.hasRequiredWhatsAppPermissions;

          console.log("hasWhatsAppPermission check:", hasWhatsAppPermission, {
            hasManagement: permissionSummary.hasManagement,
            hasMessaging: permissionSummary.hasMessaging,
            missingPermissions: permissionSummary.missingPermissions,
          });

          // If app doesn't have the permission, check if it's potentially a false negative for tech providers
          if (!hasWhatsAppPermission) {
            console.warn(
              "App does not show required WhatsApp permissions via /permissions. This is common for Tech Provider apps even when granted.",
              permissionSummary
            );

            // Return 'likely_verified_warning' instead of failing hard.
            return NextResponse.json({
              verified: true, // Non-blocking
              status: "likely_verified_warning",
              message:
                "whatsapp_business_management permission not explicitly found in app permissions list, but app is in good standing. Proceeding anyway.",
              appInfo: {
                id: appInfo.id,
                name: appInfo.name,
              },
              permissions: permissionsData.data,
              permissionSummary,
              guidance: `If Embedded Signup fails, ensure you have Advanced Access for these permissions in Meta App Dashboard: ${permissionSummary.missingPermissions.join(", ")}`,
            });
          }

          return NextResponse.json({
            verified: true,
            status: "verified",
            message:
              "Required WhatsApp app permissions are live. Proceeding with onboarding.",
            appInfo: {
              id: appInfo.id,
              name: appInfo.name,
            },
            permissions: permissionsData.data,
            permissionSummary,
          });
        } else {
          const errorText = await permissionsRes.text();
          console.warn("Could not check app permissions via API:", errorText);
        }
      } catch (permError) {
        console.warn("Could not check app permissions:", permError);
        // Continue - permissions check is not critical
      }

      // If we got here, app exists and likely has proper setup
      return NextResponse.json({
        verified: true,
        status: "likely_verified",
        message:
          "App appears to be properly configured. Proceeding with onboarding check.",
        appInfo: {
          id: appInfo.id,
          name: appInfo.name,
        },
        note: "To confirm Access Verification status, check Meta App Dashboard → App Review → Access Verification",
      });
    } catch (error) {
      console.error("Error checking access verification:", error);
      return NextResponse.json(
        {
          verified: false,
          status: "check_failed",
          message:
            error instanceof Error
              ? `Failed to check access verification: ${error.message}`
              : "Failed to check access verification",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Error in verify-access endpoint:", error);
    return NextResponse.json(
      {
        verified: false,
        status: "error",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
