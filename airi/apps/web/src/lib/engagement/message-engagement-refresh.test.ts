import { markEngagementRefreshForQueryUpdate } from "./message-engagement-refresh";

describe("durable engagement input mutation markers", () => {
  it("marks reaction removals/additions, old delivery, direction and date edits in the same write", () => {
    for (const update of [
      { $pull: { reactions: { authorId: "customer" } } },
      { $push: { reactions: { emoji: "like" } } },
      { $set: { "delivery.status": "played" } },
      { $set: { date: new Date(0), direction: "inbound" } },
      { $unset: { "origin.campaignId": 1 } },
    ])
      expect(markEngagementRefreshForQueryUpdate(update)).toEqual({
        ...update,
        $set: {
          ...("$set" in update ? update.$set : {}),
          engagementRefreshPending: true,
        },
      });
  });
  it("marks source aggregation updates while keeping projection-only writes untouched", () => {
    const pipeline = [{ $set: { text: "Price?" } }];
    expect(markEngagementRefreshForQueryUpdate(pipeline)).toEqual([
      ...pipeline,
      { $set: { engagementRefreshPending: true } },
    ]);
    const privateUpdate = {
      $set: {
        "engagementContribution.edge": {},
        engagementRefreshPending: false,
      },
    };
    expect(markEngagementRefreshForQueryUpdate(privateUpdate)).toBe(
      privateUpdate
    );
    const unrelated = { $set: { isRead: true, updatedAt: new Date() } };
    expect(markEngagementRefreshForQueryUpdate(unrelated)).toBe(unrelated);
  });
});
