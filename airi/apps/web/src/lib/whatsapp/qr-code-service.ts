/**
 * WhatsApp Cloud API phone number registration and details lookups.
 */

import {
  MetaGraphRequestError,
  getWhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import type { WhatsAppPhoneNumberDetails } from "@icecore/shared/lib/whatsapp/phone-details";

export interface RegisterPhoneNumberRequest {
  phoneNumberId: string;
  pin: string; // 6-digit PIN
  accessToken: string;
}

export type PhoneNumberDetails = WhatsAppPhoneNumberDetails;

const graphClient = getWhatsAppGraphClient();

function stringifyError(error: unknown): string {
  if (error instanceof MetaGraphRequestError) {
    if (typeof error.details === "string") {
      return error.details;
    }
    return JSON.stringify(error.details);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Registers a phone number using a 6-digit PIN
 */
export async function registerPhoneNumberWithPin({
  phoneNumberId,
  pin,
  accessToken,
}: RegisterPhoneNumberRequest): Promise<{ success: boolean }> {
  try {
    const result = await graphClient.postJson<{ success: boolean }>(
      `${phoneNumberId}/register`,
      {
        token: accessToken,
        body: {
          messaging_product: "whatsapp",
          pin,
        },
      }
    );
    if (result?.success !== true) {
      throw new Error("Meta did not confirm phone number registration");
    }
    return result;
  } catch (error) {
    throw new Error(
      `Failed to register phone number: ${stringifyError(error)}`
    );
  }
}

/**
 * Gets phone number details and verification status
 */
export async function getPhoneNumberDetails(
  phoneNumberId: string,
  accessToken: string
): Promise<PhoneNumberDetails> {
  try {
    return await graphClient.getJson<PhoneNumberDetails>(phoneNumberId, {
      token: accessToken,
      query: {
        fields:
          "id,verified_name,display_phone_number,quality_rating,whatsapp_business_manager_messaging_limit,code_verification_status,status,platform_type,is_on_biz_app,is_pin_enabled,throughput,name_status",
      },
    });
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      throw error;
    }
    throw new Error(
      `Failed to get phone number details: ${stringifyError(error)}`
    );
  }
}
