// Migration 002: convert empty JSON arrays to NULL for allowedProviders/allowedCombos/allowedKinds.
// Before this change, [] meant "all allowed" (no restriction). After the permissions refactor,
// [] means "none allowed" (block all). Any existing key with "[]" stored was saved under the old
// semantics and must be treated as NULL (unrestricted) to avoid silently blocking all requests.
export default {
  version: 2,
  name: "fix-empty-allowed-lists",
  up(db) {
    db.exec(`UPDATE apiKeys SET allowedProviders = NULL WHERE allowedProviders = '[]'`);
    db.exec(`UPDATE apiKeys SET allowedCombos    = NULL WHERE allowedCombos    = '[]'`);
    db.exec(`UPDATE apiKeys SET allowedKinds     = NULL WHERE allowedKinds     = '[]'`);
  },
};
