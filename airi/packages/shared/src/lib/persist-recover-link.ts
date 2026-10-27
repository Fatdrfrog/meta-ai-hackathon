export type PersistRecoverLinkResult<RecordValue, LinkResult> = {
  record: RecordValue;
  created: boolean;
  linkResult: LinkResult;
};

/**
 * Enforces the save-before-link retry invariant for provider-idempotent rows.
 * A pre-existing or concurrently inserted record is not acknowledged until
 * the caller's canonical link operation succeeds.
 */
export async function persistOrRecoverAndLink<RecordValue, LinkResult>(params: {
  findExisting: () => Promise<RecordValue | null>;
  persist: () => Promise<RecordValue>;
  isDuplicateError: (error: unknown) => boolean;
  link: (record: RecordValue) => Promise<LinkResult>;
}): Promise<PersistRecoverLinkResult<RecordValue, LinkResult>> {
  let record = await params.findExisting();
  let created = false;

  if (!record) {
    try {
      record = await params.persist();
      created = true;
    } catch (error) {
      if (!params.isDuplicateError(error)) {
        throw error;
      }

      record = await params.findExisting();
      if (!record) {
        throw error;
      }
    }
  }

  const linkResult = await params.link(record);
  return { record, created, linkResult };
}
