// The builder's template drawer creates templates through server actions
// that run in this page's function. A carousel's create gives Meta 25 s
// after its header uploads, then reads its status back: more than the 15 s
// default without Fluid compute. 300 s is the default with it, so no action
// here gets less time than before.
export const maxDuration = 300;

export { default } from "@/features/panel/scenarios/route";
