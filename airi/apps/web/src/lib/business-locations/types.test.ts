import {
  MAX_BUSINESS_LOCATION_RECORDS,
  MAX_BUSINESS_LOCATIONS_PER_SAVE,
  findBusinessLocationOutliers,
  summarizeBusinessLocations,
  toBusinessLocationInput,
  validateBusinessLocationInput,
  type BusinessLocationInput,
  type BusinessLocationRecord,
} from "./types";

const abayInput: BusinessLocationInput = {
  key: "kz_almaty_abay",
  name: "Abay",
  country: "kz",
  city: "Almaty",
  address: "Abay Ave 10",
  phone: "+7 727 000 00 00",
  mapUrl: "https://maps.google.com/?q=43.24,76.91",
  tags: ["Flagship", "24/7"],
  latitude: "43,238949",
  longitude: 76.889709,
};

function record(
  key: string,
  overrides: Partial<BusinessLocationRecord> = {}
): BusinessLocationRecord {
  return {
    key,
    name: key,
    country: "KZ",
    city: "Almaty",
    cityKey: "almaty",
    tags: [],
    latitude: 43.24,
    longitude: 76.91,
    sortOrder: 0,
    isActive: true,
    updatedAt: null,
    ...overrides,
  };
}

describe("business location limits", () => {
  it("caps one save at the active-office limit and the catalog at 2000 records", () => {
    expect(MAX_BUSINESS_LOCATIONS_PER_SAVE).toBe(500);
    expect(MAX_BUSINESS_LOCATION_RECORDS).toBe(2000);
  });
});

describe("validateBusinessLocationInput", () => {
  it("returns the stored shape of an office entered correctly", () => {
    expect(validateBusinessLocationInput(abayInput)).toEqual({
      ok: true,
      office: {
        key: "kz_almaty_abay",
        name: "Abay",
        country: "KZ",
        city: "Almaty",
        cityKey: "almaty",
        address: "Abay Ave 10",
        phone: "+7 727 000 00 00",
        mapUrl: "https://maps.google.com/?q=43.24,76.91",
        tags: ["flagship", "24/7"],
        latitude: 43.238949,
        longitude: 76.889709,
        sortOrder: 0,
      },
      isActive: true,
      sortOrder: undefined,
    });
  });

  it("keeps an explicit deactivation and sort order", () => {
    const result = validateBusinessLocationInput({
      ...abayInput,
      isActive: false,
      sortOrder: 7,
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, isActive: false, sortOrder: 7 })
    );
    expect(result.ok && result.office.sortOrder).toBe(7);
  });

  it("treats a null sort order as absent", () => {
    expect(
      validateBusinessLocationInput({ ...abayInput, sortOrder: null })
    ).toEqual(expect.objectContaining({ ok: true, sortOrder: undefined }));
  });

  it("refuses what the lenient runtime normalizer would quietly fix", () => {
    expect(
      validateBusinessLocationInput({
        ...abayInput,
        mapUrl: "http://maps.google.com/?q=43.24,76.91",
        tags: Array.from({ length: 11 }, (_, index) => `tag ${index}`),
        name: "N".repeat(161),
        sortOrder: 1.5,
      })
    ).toEqual({
      ok: false,
      issues: [
        "name_too_long",
        "map_url_invalid",
        "tags_too_many",
        "sort_order_invalid",
      ],
    });
  });

  it("refuses an office routing could not use", () => {
    expect(
      validateBusinessLocationInput({
        ...abayInput,
        key: "bad key",
        latitude: 0,
        longitude: 0,
      })
    ).toEqual({ ok: false, issues: ["key_invalid", "coordinates_zero"] });
    expect(validateBusinessLocationInput(null)).toEqual({
      ok: false,
      issues: [
        "key_invalid",
        "name_missing",
        "country_invalid",
        "city_missing",
        "latitude_invalid",
        "longitude_invalid",
      ],
    });
  });
});

describe("toBusinessLocationInput", () => {
  const validated = validateBusinessLocationInput({
    ...abayInput,
    sortOrder: 4,
  });
  if (!validated.ok) throw new Error("abayInput must be valid");
  const stored: BusinessLocationRecord = {
    ...validated.office,
    isActive: false,
    updatedAt: "2026-10-05T08:00:00.000Z",
  };

  it("sends a stored office back whole, and it validates to the same office", () => {
    const input = toBusinessLocationInput(stored);

    expect(input).toStrictEqual({
      key: "kz_almaty_abay",
      name: "Abay",
      country: "KZ",
      city: "Almaty",
      address: "Abay Ave 10",
      phone: "+7 727 000 00 00",
      mapUrl: "https://maps.google.com/?q=43.24,76.91",
      tags: ["flagship", "24/7"],
      latitude: 43.238949,
      longitude: 76.889709,
      isActive: false,
      sortOrder: 4,
    });
    expect(validateBusinessLocationInput(input)).toEqual({
      ok: true,
      office: validated.office,
      isActive: false,
      sortOrder: 4,
    });
  });

  it("leaves out the optional fields an office doesn't have", () => {
    const office = record("almaty_abay");
    const input = toBusinessLocationInput(office);

    expect(input).toStrictEqual({
      key: "almaty_abay",
      name: "almaty_abay",
      country: "KZ",
      city: "Almaty",
      latitude: 43.24,
      longitude: 76.91,
      isActive: true,
      sortOrder: 0,
    });
    expect(validateBusinessLocationInput(input)).toEqual({
      ok: true,
      office: {
        key: "almaty_abay",
        name: "almaty_abay",
        country: "KZ",
        city: "Almaty",
        cityKey: "almaty",
        tags: [],
        latitude: 43.24,
        longitude: 76.91,
        sortOrder: 0,
      },
      isActive: true,
      sortOrder: 0,
    });
  });

  it("applies overrides, and an undefined override clears an optional field", () => {
    const input = toBusinessLocationInput(stored, {
      isActive: true,
      name: "Abay Center",
      address: undefined,
      mapUrl: undefined,
      tags: ["new"],
    });

    expect(input).toStrictEqual({
      key: "kz_almaty_abay",
      name: "Abay Center",
      country: "KZ",
      city: "Almaty",
      phone: "+7 727 000 00 00",
      tags: ["new"],
      latitude: 43.238949,
      longitude: 76.889709,
      isActive: true,
      sortOrder: 4,
    });
    expect(validateBusinessLocationInput(input)).toEqual(
      expect.objectContaining({ ok: true, isActive: true, sortOrder: 4 })
    );
  });

  it("copies the tags, so changing the row leaves the record alone", () => {
    const input = toBusinessLocationInput(stored);
    input.tags?.push("extra");

    expect(stored.tags).toEqual(["flagship", "24/7"]);
  });
});

describe("summarizeBusinessLocations", () => {
  it("counts active offices and the distinct cities and countries they cover", () => {
    expect(
      summarizeBusinessLocations([
        record("almaty_abay"),
        record("almaty_dostyk"),
        record("astana_center", { city: "Astana", cityKey: "astana" }),
        record("tashkent_center", {
          country: "UZ",
          city: "Tashkent",
          cityKey: "tashkent",
        }),
        record("bishkek_closed", {
          country: "KG",
          city: "Bishkek",
          cityKey: "bishkek",
          isActive: false,
        }),
      ])
    ).toEqual({ active: 4, cities: 3, countries: 2 });
  });

  it("keeps same-name cities of two countries apart", () => {
    expect(
      summarizeBusinessLocations([
        record("a", { country: "KZ", cityKey: "aral" }),
        record("b", { country: "UZ", cityKey: "aral" }),
      ])
    ).toEqual({ active: 2, cities: 2, countries: 2 });
  });

  it("is all zeros for an empty catalog", () => {
    expect(summarizeBusinessLocations([])).toEqual({
      active: 0,
      cities: 0,
      countries: 0,
    });
  });
});

describe("findBusinessLocationOutliers", () => {
  it("reports an active office far from the other active offices of its city", () => {
    const outliers = findBusinessLocationOutliers([
      record("almaty_abay"),
      record("almaty_dostyk", { latitude: 43.25, longitude: 76.95 }),
      record("almaty_typo", { latitude: 34.24, longitude: 76.91 }),
    ]);

    expect(outliers).toEqual([
      expect.objectContaining({
        key: "almaty_typo",
        cityValue: "KZ:almaty",
        nearestKey: "almaty_abay",
      }),
    ]);
    expect(outliers[0]?.distanceMeters).toBeGreaterThan(50_000);
  });

  it("leaves inactive offices out of the comparison", () => {
    expect(
      findBusinessLocationOutliers([
        record("almaty_abay"),
        record("almaty_typo", {
          latitude: 34.24,
          longitude: 76.91,
          isActive: false,
        }),
      ])
    ).toEqual([]);
  });
});
