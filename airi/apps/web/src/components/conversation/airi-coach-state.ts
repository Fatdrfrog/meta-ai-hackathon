import { atom } from "jotai";

export const coachOpenAtom = atom(false);
export const airiTypingAtom = atom(false);
/** User explicitly closed the coach dock this conversation. */
export const coachUserClosedAtom = atom(false);
/** Tips arrived while panel closed / user-closed. */
export const coachUnreadAtom = atom(false);
