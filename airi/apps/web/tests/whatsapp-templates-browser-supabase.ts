// Replace only database transport; the real editor and its validation run.
export function createClient() {
  return {
    from(table: string) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        then(resolve: (result: unknown) => unknown) {
          return fetch(
            `/__browser/templates/database?table=${encodeURIComponent(table)}`
          )
            .then(response => response.json())
            .then(resolve);
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
      };
      return query;
    },
  };
}
