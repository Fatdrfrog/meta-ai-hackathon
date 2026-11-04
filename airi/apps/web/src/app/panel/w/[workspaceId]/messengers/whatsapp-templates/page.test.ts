/** @jest-environment node */

jest.mock("@/features/panel/messengers/whatsapp-templates-route", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/features/panel/scenarios/route", () => ({
  __esModule: true,
  default: () => null,
}));

import * as scenariosPage from "../../scenarios/page";
import * as templatesPage from "./page";

describe("pages that show the template editor", () => {
  it.each([
    ["Templates", templatesPage],
    ["Scenarios", scenariosPage],
  ])(
    "%s gives the editor's server actions time for a carousel's create",
    (_page, page) => {
      // Meta gets 25 s after the card headers are uploaded, then the status
      // is read back (10 s at most); 300 s is the platform's own default
      // with Fluid compute, so nothing on the page gets less than before.
      expect(page.maxDuration).toBe(300);
      expect(typeof page.default).toBe("function");
    }
  );
});
