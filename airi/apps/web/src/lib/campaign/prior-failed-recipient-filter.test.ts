import {
  canonicalizeBulkCampaignRecipientIdentity,
  hashBulkCampaignRecipientIdentity,
} from "./bulk-campaign-safety";
import {
  PriorFailedBulkCampaignLookupError,
  filterPriorFailedBulkCampaignCandidates,
} from "./prior-failed-recipient-filter";

const secret = "test-encryption-secret";
const workspaceId = "11111111-1111-4111-8111-111111111111";

function recipientHash(phone: string): string {
  const identity = canonicalizeBulkCampaignRecipientIdentity({
    channel: "whatsapp",
    recipient: { phone },
  });
  if (!identity) throw new Error("Test phone did not canonicalize");
  return hashBulkCampaignRecipientIdentity({
    secret,
    workspaceId,
    channel: "whatsapp",
    identity,
  });
}

describe("filterPriorFailedBulkCampaignCandidates", () => {
  it("excludes every candidate whose stable recipient hash is returned by the projection RPC", async () => {
    const failedHash = recipientHash("+1 (555) 000-0001");
    const rpc = jest.fn().mockResolvedValue({
      data: [{ recipient_hash: failedHash }],
      error: null,
    });
    const candidates = [
      { recipient: { phone: "+1 (555) 000-0001" }, label: "first" },
      { recipient: { phone: "+15550000002" }, label: "second" },
      { recipient: { phone: "15550000001" }, label: "duplicate" },
    ];

    const result = await filterPriorFailedBulkCampaignCandidates({
      client: { rpc },
      secret,
      workspaceId,
      channel: "whatsapp",
      candidates,
      recipientFor: candidate => candidate.recipient,
    });

    expect(result).toEqual({
      candidates: [candidates[1]],
      skippedPriorFailed: 2,
    });
    expect(rpc).toHaveBeenCalledWith(
      "get_prior_failed_bulk_campaign_recipient_hashes",
      {
        p_workspace_id: workspaceId,
        p_channel: "whatsapp",
        p_recipient_hashes: [failedHash, recipientHash("+15550000002")],
      }
    );
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("15550000001");
  });

  it("uses 5,000-recipient default RPC chunks without changing candidate order", async () => {
    const candidates = Array.from({ length: 5_001 }, (_, index) => ({
      phone: `+1555${String(index).padStart(7, "0")}`,
    }));
    const failedHash = recipientHash(candidates[5_000].phone);
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({
        data: [{ recipient_hash: failedHash }],
        error: null,
      });

    const result = await filterPriorFailedBulkCampaignCandidates({
      client: { rpc },
      secret,
      workspaceId,
      channel: "whatsapp",
      candidates,
      recipientFor: candidate => candidate,
    });

    expect(result).toEqual({
      candidates: candidates.slice(0, 5_000),
      skippedPriorFailed: 1,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_recipient_hashes).toHaveLength(5_000);
    expect(rpc.mock.calls[1][1].p_recipient_hashes).toEqual([failedHash]);
    const rawPhones = new Set(candidates.map(candidate => candidate.phone));
    const rawIdentities = new Set(
      candidates.map(candidate => {
        const identity = canonicalizeBulkCampaignRecipientIdentity({
          channel: "whatsapp",
          recipient: candidate,
        });
        if (!identity) throw new Error("Test phone did not canonicalize");
        return identity;
      })
    );
    for (const [, args] of rpc.mock.calls) {
      expect(Object.keys(args)).toEqual([
        "p_workspace_id",
        "p_channel",
        "p_recipient_hashes",
      ]);
      const submittedHashes = args.p_recipient_hashes as unknown[];
      expect(submittedHashes.length).toBeGreaterThan(0);
      for (const submittedHash of submittedHashes) {
        expect(submittedHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
        expect(rawPhones).not.toContain(submittedHash);
        expect(rawIdentities).not.toContain(submittedHash);
      }
    }
  });

  it("uses bounded concurrency for high-cardinality chunk lookups", async () => {
    let activeLookups = 0;
    let peakActiveLookups = 0;
    const rpc = jest.fn(async () => {
      activeLookups += 1;
      peakActiveLookups = Math.max(peakActiveLookups, activeLookups);
      await Promise.resolve();
      activeLookups -= 1;
      return { data: [], error: null };
    });
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      phone: `+155500000${String(index).padStart(2, "0")}`,
    }));

    await filterPriorFailedBulkCampaignCandidates({
      client: { rpc },
      secret,
      workspaceId,
      channel: "whatsapp",
      candidates,
      recipientFor: candidate => candidate,
      lookupChunkSize: 1,
    });

    expect(rpc).toHaveBeenCalledTimes(10);
    expect(peakActiveLookups).toBeGreaterThan(1);
    expect(peakActiveLookups).toBeLessThanOrEqual(4);
  });

  it("does not query Supabase when there are no candidates", async () => {
    const rpc = jest.fn();

    await expect(
      filterPriorFailedBulkCampaignCandidates({
        client: { rpc },
        secret,
        workspaceId,
        channel: "whatsapp",
        candidates: [],
        recipientFor: candidate => candidate,
      })
    ).resolves.toEqual({ candidates: [], skippedPriorFailed: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the projection lookup is unavailable", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "function is missing" },
    });

    await expect(
      filterPriorFailedBulkCampaignCandidates({
        client: { rpc },
        secret,
        workspaceId,
        channel: "whatsapp",
        candidates: [{ phone: "+15550000001" }],
        recipientFor: candidate => candidate,
      })
    ).rejects.toBeInstanceOf(PriorFailedBulkCampaignLookupError);
  });

  it("fails closed when the projection returns an invalid row", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [{ recipient_hash: "not-a-hash" }],
      error: null,
    });

    await expect(
      filterPriorFailedBulkCampaignCandidates({
        client: { rpc },
        secret,
        workspaceId,
        channel: "whatsapp",
        candidates: [{ phone: "+15550000001" }],
        recipientFor: candidate => candidate,
      })
    ).rejects.toBeInstanceOf(PriorFailedBulkCampaignLookupError);
  });

  it("fails closed when the projection returns a hash outside the submitted chunk", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [{ recipient_hash: "a".repeat(64) }],
      error: null,
    });

    await expect(
      filterPriorFailedBulkCampaignCandidates({
        client: { rpc },
        secret,
        workspaceId,
        channel: "whatsapp",
        candidates: [{ phone: "+15550000001" }],
        recipientFor: candidate => candidate,
      })
    ).rejects.toBeInstanceOf(PriorFailedBulkCampaignLookupError);
  });

  it("fails closed when a non-empty lookup returns null without an RPC error", async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });

    await expect(
      filterPriorFailedBulkCampaignCandidates({
        client: { rpc },
        secret,
        workspaceId,
        channel: "whatsapp",
        candidates: [{ phone: "+15550000001" }],
        recipientFor: candidate => candidate,
      })
    ).rejects.toBeInstanceOf(PriorFailedBulkCampaignLookupError);
  });

  it("uses the exact configured secret so lookup hashes match admission hashes", async () => {
    const exactSecret = "  secret-with-intentional-whitespace  ";
    const identity = canonicalizeBulkCampaignRecipientIdentity({
      channel: "whatsapp",
      recipient: { phone: "+15550000001" },
    });
    if (!identity) throw new Error("Test phone did not canonicalize");
    const expectedHash = hashBulkCampaignRecipientIdentity({
      secret: exactSecret,
      workspaceId,
      channel: "whatsapp",
      identity,
    });
    const rpc = jest.fn().mockResolvedValue({ data: [], error: null });

    await filterPriorFailedBulkCampaignCandidates({
      client: { rpc },
      secret: exactSecret,
      workspaceId,
      channel: "whatsapp",
      candidates: [{ phone: "+15550000001" }],
      recipientFor: candidate => candidate,
    });

    expect(rpc.mock.calls[0][1].p_recipient_hashes).toEqual([expectedHash]);
  });
});
