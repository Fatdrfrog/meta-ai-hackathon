import React from "react";
import { getTranslations } from "next-intl/server";

const UnauthorizedPage = async () => {
  const t = await getTranslations("Auth");
  return (
    <div>
      <h1>{t("unauthorizedTitle")}</h1>
      <p>{t("unauthorizedDescription")}</p>
    </div>
  );
};

export default UnauthorizedPage;
