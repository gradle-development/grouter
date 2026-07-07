// Migration 002: convert empty JSON arrays to NULL for allowedProviders/allowedCombos/allowedKinds.
// Before this change, [] meant "all allowed" (no restriction). After the permissions refactor,
// [] means "none allowed" (block all). Any existing key with "[]" stored was saved under the old
// semantics and must be treated as NULL (unrestricted) to avoid silently blocking all requests.
//
// NOTE: This migration must be idempotent — the columns may not exist yet if migrating from
// a pre-ACL schema (e.g. 9Router v0.5.x). Migration 003 adds them. Running UPDATE on
// non-existent columns would crash the entire migration chain.
