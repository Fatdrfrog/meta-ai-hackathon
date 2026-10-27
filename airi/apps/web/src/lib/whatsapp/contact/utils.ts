export function parseWhatsAppName(profileName: string | undefined | null): {
  firstName: string | undefined;
  lastName: string | undefined;
  fullName: string | undefined;
} {
  if (!profileName || profileName.trim() === "" || profileName === "Customer") {
    return {
      firstName: undefined,
      lastName: undefined,
      fullName: undefined,
    };
  }

  const trimmed = profileName.trim();

  const cleanName = trimmed.replace(/^Customer\s*/i, "").trim();
  if (!cleanName) {
    return {
      firstName: undefined,
      lastName: undefined,
      fullName: undefined,
    };
  }

  const parts = cleanName.split(/\s+/).filter(part => part.length > 0);

  if (parts.length === 0) {
    return {
      firstName: undefined,
      lastName: undefined,
      fullName: undefined,
    };
  }

  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: undefined,
      fullName: parts[0],
    };
  }

  const firstName = parts[0];
  const lastName = parts.slice(1).join(" ");

  return {
    firstName,
    lastName,
    fullName: cleanName,
  };
}
