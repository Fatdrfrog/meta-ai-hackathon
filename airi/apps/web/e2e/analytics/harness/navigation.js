export const usePathname = () =>
  new URLSearchParams(location.search).get("view") === "dashboards"
    ? "/panel/w/qa-workspace/analytics"
    : "/panel/w/qa-workspace/analytics/outcomes";
