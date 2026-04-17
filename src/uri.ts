/**
 * URI generation for graph entities.
 *
 * All entity IDs are CURIEs: <kind>:<slug>
 * - kind is lowercased, hyphenated class name
 * - slug is derived from title (or ULID fallback)
 */

/** Convert PascalCase to kebab-case */
export function toKebabCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/** Slugify a title: lowercase, hyphens for spaces, strip special chars */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Minimal ULID implementation (no npm dependency).
 * Generates a 26-char Crockford Base32 string: 10 chars timestamp + 16 chars random.
 */
export function ulid(): string {
  const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford Base32 lowercase
  const now = Date.now();
  let id = "";

  // 10-char timestamp (48-bit ms epoch)
  let ts = now;
  for (let i = 9; i >= 0; i--) {
    id = ENCODING[ts & 31]! + id;
    ts = Math.floor(ts / 32);
  }

  // 16-char random
  for (let i = 0; i < 16; i++) {
    id += ENCODING[Math.floor(Math.random() * 32)];
  }

  return id;
}

/**
 * Generate a unique CURIE id for a node.
 *
 * @param sql - SqlStorage instance for collision checking
 * @param kind - PascalCase kind (e.g. "ProjectConcern")
 * @param title - optional title to derive slug from
 * @returns CURIE like "project-concern:my-slug" or "note:0123abcd..."
 */
export function generateNodeId(
  sql: SqlStorage,
  kind: string,
  title?: string,
): string {
  const kindSlug = toKebabCase(kind);

  if (!title) {
    const id = `${kindSlug}:${ulid()}`;
    return id;
  }

  const baseSlug = slugify(title);
  const baseId = `${kindSlug}:${baseSlug}`;

  // Check if base ID is available
  const exists = sql
    .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM nodes WHERE id = ?", baseId)
    .one();
  if (exists.cnt === 0) return baseId;

  // Try suffixed IDs
  for (let i = 2; i <= 100; i++) {
    const candidateId = `${kindSlug}:${baseSlug}-${i}`;
    const check = sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM nodes WHERE id = ?", candidateId)
      .one();
    if (check.cnt === 0) return candidateId;
  }

  throw new Error(`ID collision: could not generate unique ID for kind=${kind} title=${title}`);
}

/**
 * Generate a unique CURIE id for an edge.
 *
 * Format: <rel-type-kebab>:<source-slug>--<target-slug>
 */
export function generateEdgeId(
  sql: SqlStorage,
  relType: string,
  sourceId: string,
  targetId: string,
): string {
  const relSlug = toKebabCase(relType);
  // Extract slug portion from source and target CURIEs
  const sourceSlug = sourceId.includes(":") ? sourceId.split(":").slice(1).join(":") : sourceId;
  const targetSlug = targetId.includes(":") ? targetId.split(":").slice(1).join(":") : targetId;

  const baseId = `${relSlug}:${sourceSlug}--${targetSlug}`;

  const exists = sql
    .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM edges WHERE id = ?", baseId)
    .one();
  if (exists.cnt === 0) return baseId;

  for (let i = 2; i <= 100; i++) {
    const candidateId = `${baseId}-${i}`;
    const check = sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM edges WHERE id = ?", candidateId)
      .one();
    if (check.cnt === 0) return candidateId;
  }

  throw new Error(`Edge ID collision: could not generate unique ID for ${relType} ${sourceId}->${targetId}`);
}
