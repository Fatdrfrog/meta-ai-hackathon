import {
  mapScenarioNodeMedia,
  type ScenarioMediaLocation,
} from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";

/*
 * A scenario detail read with deferred media signing can hold durable media
 * refs (gcs://) where the editor shows images. A later read of the same
 * scenario returns them signed. These helpers carry only those display URLs
 * onto the canvas, and only where the canvas still holds the durable value
 * that was loaded, so nothing a user changed since is touched.
 */

type MediaByLocation = Map<string, unknown>;

/** Durable media values of a loaded detail, by node id and location. */
export type PendingScenarioMedia = {
  updatedAt: string | null;
  byNodeId: Map<string, MediaByLocation>;
};

/** Signed display values for durable ones, by node id and location. */
export type SignedScenarioMedia = Map<
  string,
  Map<string, { durable: unknown; signed: unknown }>
>;

type GraphNodeLike = { id?: unknown; data?: unknown };

function isDurableRef(url: unknown): boolean {
  return (
    typeof url === "string" &&
    (url.startsWith("gcs://") || url.startsWith("gs://"))
  );
}

function isSignedUrl(url: unknown): boolean {
  return typeof url === "string" && url.startsWith("https://");
}

function isDurableMedia(value: unknown): boolean {
  return isDurableRef(isRecord(value) ? value.url : value);
}

function locationKey(location: ScenarioMediaLocation): string {
  return JSON.stringify(location);
}

function collectNodeMedia(
  data: unknown,
  include: (value: unknown) => boolean
): MediaByLocation {
  const media: MediaByLocation = new Map();
  mapScenarioNodeMedia(data, (value, location) => {
    if (include(value)) media.set(locationKey(location), value);
    return value;
  });
  return media;
}

function nodesById(nodes: readonly unknown[]): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  for (const node of nodes) {
    const { id, data } = (isRecord(node) ? node : {}) as GraphNodeLike;
    if (typeof id === "string" && id) byId.set(id, data);
  }
  return byId;
}

/** The durable media a loaded detail's nodes hold. */
export function collectPendingScenarioMedia(
  nodes: readonly unknown[],
  updatedAt: string | null
): PendingScenarioMedia {
  const byNodeId = new Map<string, MediaByLocation>();
  for (const [nodeId, data] of nodesById(nodes)) {
    const media = collectNodeMedia(data, isDurableMedia);
    if (media.size > 0) byNodeId.set(nodeId, media);
  }
  return { updatedAt, byNodeId };
}

function hasObjectIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.bucket === "string" &&
    typeof value.path === "string" &&
    Boolean(value.bucket && value.path)
  );
}

/**
 * The signed value for a durable one: the same object signed (same bucket
 * and path, https url). Media without a bucket and path, such as legacy URL
 * strings, has no identity to compare, so only the same place in the same
 * revision counts.
 */
function signedValueFor(
  durable: unknown,
  latest: unknown,
  sameRevision: boolean
): unknown {
  if (!isRecord(durable)) {
    return sameRevision && isSignedUrl(latest) ? latest : undefined;
  }
  if (!isRecord(latest) || !isSignedUrl(latest.url)) return undefined;
  const sameObject = hasObjectIdentity(durable)
    ? latest.bucket === durable.bucket && latest.path === durable.path
    : sameRevision;
  return sameObject ? { ...durable, url: latest.url } : undefined;
}

function matchNodeMedia(
  pending: MediaByLocation,
  latestData: unknown,
  sameRevision: boolean
) {
  const signed = new Map<string, { durable: unknown; signed: unknown }>();
  const latest = collectNodeMedia(latestData, () => true);
  for (const [key, durable] of pending) {
    const value = signedValueFor(durable, latest.get(key), sameRevision);
    if (value !== undefined) signed.set(key, { durable, signed: value });
  }
  return signed;
}

/**
 * Pairs the durable media still pending with a newer read of the same
 * scenario, and removes what it signed from `pending`.
 */
export function takeSignedScenarioMedia(
  pending: PendingScenarioMedia,
  latestNodes: readonly unknown[],
  latestUpdatedAt: string | null
): SignedScenarioMedia {
  const signed: SignedScenarioMedia = new Map();
  const latestById = nodesById(latestNodes);
  const sameRevision =
    pending.updatedAt !== null && pending.updatedAt === latestUpdatedAt;
  for (const [nodeId, media] of pending.byNodeId) {
    if (!latestById.has(nodeId)) continue;
    const matched = matchNodeMedia(media, latestById.get(nodeId), sameRevision);
    if (matched.size === 0) continue;
    signed.set(nodeId, matched);
    for (const key of matched.keys()) media.delete(key);
    if (media.size === 0) pending.byNodeId.delete(nodeId);
  }
  return signed;
}

/**
 * The value to show for `current`, a canvas value where durable media was
 * loaded: the signed one while it is still that same durable media. An
 * object whose other fields (a file name, say) changed since keeps them and
 * gets only the signed url.
 */
function signedCanvasValue(
  current: unknown,
  entry: { durable: unknown; signed: unknown }
): unknown {
  const { durable, signed } = entry;
  if (current === durable) return signed;
  if (!isRecord(current) || !isRecord(durable) || !isRecord(signed)) {
    return current;
  }
  const sameMedia =
    current.url === durable.url &&
    current.bucket === durable.bucket &&
    current.path === durable.path;
  return sameMedia ? { ...current, url: signed.url } : current;
}

/**
 * Shows signed media where a node still holds the durable media that was
 * loaded. Returns the same array when nothing changed.
 */
export function applySignedScenarioMedia<
  T extends { id: string; data: unknown },
>(nodes: T[], signed: SignedScenarioMedia): T[] {
  let changed = false;
  const next = nodes.map(node => {
    const media = signed.get(node.id);
    if (!media) return node;
    const data = mapScenarioNodeMedia(node.data, (value, location) => {
      const entry = media.get(locationKey(location));
      return entry ? signedCanvasValue(value, entry) : value;
    });
    if (data === node.data) return node;
    changed = true;
    return { ...node, data };
  });
  return changed ? next : nodes;
}
