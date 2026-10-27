import { createClient } from "@/lib/supabase/client";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";

export interface BusinessPrefillData {
  businessName?: string;
  businessEmail?: string;
  businessPhone?: string;
  preferredDisplayName?: string;
}

export async function getBusinessPrefillData(
  workspaceId: string
): Promise<BusinessPrefillData> {
  const supabase = createClient();

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return {};
    }

    const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
    // Select existing columns only: companies has no industry column, and an
    // unknown column fails the whole read and drops the business name.
    const { data: company } = companyId
      ? await supabase
          .from("companies")
          .select("name")
          .eq("id", companyId)
          .single()
      : { data: null };

    const prefillData: BusinessPrefillData = {};

    if (company?.name) {
      prefillData.businessName = company.name;
      prefillData.preferredDisplayName = `${company.name} Support`;
    }

    if (user.email) {
      prefillData.businessEmail = user.email;
    }

    if (user.user_metadata?.phone) {
      prefillData.businessPhone = user.user_metadata.phone;
    }

    return prefillData;
  } catch {
    return {};
  }
}
