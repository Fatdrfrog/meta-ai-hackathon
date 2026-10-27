import { createPreparedBulkCampaignContentHash } from "./bulk-campaign-content-hash";

describe("prepared bulk campaign ordinal content hash", () => {
  const recipientHash = "a".repeat(64);
  const firstSnapshot = {
    recipientHash,
    snapshotOrdinal: 0,
    dispatchSnapshot: { messageText: "first" },
  };
  const secondSnapshot = {
    recipientHash,
    snapshotOrdinal: 1,
    dispatchSnapshot: { messageText: "second" },
  };

  it("serializes retained duplicate recipients in immutable ordinal order", () => {
    expect(
      createPreparedBulkCampaignContentHash([secondSnapshot, firstSnapshot])
    ).toBe(
      createPreparedBulkCampaignContentHash([firstSnapshot, secondSnapshot])
    );
  });

  it("binds the immutable ordinal and item multiplicity", () => {
    const renumbered = [
      { ...firstSnapshot, snapshotOrdinal: 2 },
      { ...secondSnapshot, snapshotOrdinal: 3 },
    ];

    expect(createPreparedBulkCampaignContentHash(renumbered)).not.toBe(
      createPreparedBulkCampaignContentHash([firstSnapshot, secondSnapshot])
    );
    expect(createPreparedBulkCampaignContentHash([firstSnapshot])).not.toBe(
      createPreparedBulkCampaignContentHash([firstSnapshot, secondSnapshot])
    );
  });
});
