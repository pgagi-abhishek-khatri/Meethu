const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const {
  validateOkfRegistry,
  parseFrontmatter,
  computeSha256,
  DocumentMetadataSchema,
  BundleManifestSchema,
} = require("../../scripts/validate-okf");

test("OKF repository bundle is currently 100% valid", () => {
  const result = validateOkfRegistry();
  assert.equal(result.valid, true, `Validation failed: ${result.errors.join("; ")}`);
  assert.ok(result.checkedCount >= 2, "Expected at least 2 canonical documents");
  assert.equal(result.errors.length, 0);
});

test("parseFrontmatter parses valid YAML frontmatter and isolates body", () => {
  const input = `---
id: "OKF-0001"
title: "Sample Spec"
---
# Document Content
Hello world`;
  const { frontmatter, body } = parseFrontmatter(input);
  assert.equal(frontmatter.id, "OKF-0001");
  assert.equal(frontmatter.title, "Sample Spec");
  assert.ok(body.includes("# Document Content"));
});

test("parseFrontmatter throws when frontmatter delimiters are missing", () => {
  assert.throws(() => {
    parseFrontmatter("# Just markdown without frontmatter");
  }, /missing standard YAML frontmatter delimiters/);
});

test("DocumentMetadataSchema validates valid frontmatter object", () => {
  const validDoc = {
    id: "OKF-0099",
    title: "Test Specification Title",
    description: "Detailed description of the test specification purpose.",
    owner: "pgagi-abhishek-khatri",
    status: "approved",
    version: "1.0.0",
    canonical: true,
    bundle_id: "openwhispr-canonical-v1",
    tags: ["domain:copilot", "type:architecture"],
    superseded_by: null,
    created_at: "2026-11-16T11:00:00Z",
    updated_at: "2026-11-16T11:00:00Z",
  };
  const result = DocumentMetadataSchema.safeParse(validDoc);
  assert.equal(result.success, true);
});

test("DocumentMetadataSchema rejects invalid document ID", () => {
  const invalid = {
    id: "INVALID-123",
    title: "Test Specification",
    description: "Detailed description of the test specification purpose.",
    owner: "tester",
    status: "approved",
    version: "1.0.0",
    canonical: true,
    bundle_id: "bundle-1",
    tags: ["domain:copilot"],
    created_at: "2026-11-16T11:00:00Z",
    updated_at: "2026-11-16T11:00:00Z",
  };
  const result = DocumentMetadataSchema.safeParse(invalid);
  assert.equal(result.success, false);
});

test("DocumentMetadataSchema rejects invalid SemVer", () => {
  const invalid = {
    id: "OKF-0010",
    title: "Test Specification",
    description: "Detailed description of the test specification purpose.",
    owner: "tester",
    status: "approved",
    version: "v1.0", // invalid semver format
    canonical: true,
    bundle_id: "bundle-1",
    tags: ["domain:copilot"],
    created_at: "2026-11-16T11:00:00Z",
    updated_at: "2026-11-16T11:00:00Z",
  };
  const result = DocumentMetadataSchema.safeParse(invalid);
  assert.equal(result.success, false);
});

test("DocumentMetadataSchema rejects uncontrolled tag namespaces", () => {
  const invalid = {
    id: "OKF-0010",
    title: "Test Specification",
    description: "Detailed description of the test specification purpose.",
    owner: "tester",
    status: "approved",
    version: "1.0.0",
    canonical: true,
    bundle_id: "bundle-1",
    tags: ["random:tag", "unnamespaced-tag"],
    created_at: "2026-11-16T11:00:00Z",
    updated_at: "2026-11-16T11:00:00Z",
  };
  const result = DocumentMetadataSchema.safeParse(invalid);
  assert.equal(result.success, false);
});

test("DocumentMetadataSchema requires superseded_by when status is superseded", () => {
  const invalid = {
    id: "OKF-0010",
    title: "Test Specification",
    description: "Detailed description of the test specification purpose.",
    owner: "tester",
    status: "superseded",
    version: "1.0.0",
    canonical: true,
    bundle_id: "bundle-1",
    tags: ["domain:copilot"],
    superseded_by: null, // missing required pointer
    created_at: "2026-11-16T11:00:00Z",
    updated_at: "2026-11-16T11:00:00Z",
  };
  const result = DocumentMetadataSchema.safeParse(invalid);
  assert.equal(result.success, false);
});

test("computeSha256 calculates stable SHA-256 string", () => {
  const h1 = computeSha256("test-content");
  const h2 = computeSha256("test-content");
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});
