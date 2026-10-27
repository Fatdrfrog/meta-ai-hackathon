export function usePathname() {
  return "/panel/w/browser-workspace/messengers/whatsapp-templates";
}
const searchParams = new URLSearchParams();
export function useSearchParams() {
  return searchParams;
}
export function useRouter() {
  return { replace() {}, push() {}, refresh() {} };
}
