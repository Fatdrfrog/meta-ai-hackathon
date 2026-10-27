import User from "@/models/user";

/**
 * Author of messages the business sends from the Instagram app, one per
 * account, as WhatsApp's phone-app echoes have: a person, not Airi.
 */
export function instagramBusinessAuthorId(businessAccountId: string) {
  return `instagram_business_${businessAccountId}`;
}

export function upsertInstagramBusinessAuthor(businessAccountId: string) {
  return User.findOneAndUpdate(
    { _id: instagramBusinessAuthorId(businessAccountId) },
    { firstName: "Business Account", isBot: false },
    { upsert: true, new: true }
  );
}
