// Phase 5.6: the JSON Schemas in OKF/schemas are documented as the machine-readable contract, so they must keep
// agreeing with the real bundle and with what the validator enforces. ajv is only a transitive dependency, so the
// suite skips when it cannot be loaded rather than forcing a new one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

let Ajv = null;
try {
  Ajv = require("ajv/dist/2020");
} catch {
  Ajv = null;
}
const ajvOpts = { skip: Ajv ? false : "ajv is not installed" };
const R = path.resolve(__dirname, "../../OKF");
const schema = (f) => JSON.parse(fs.readFileSync(path.join(R, "schemas", f), "utf8"));
const validator = (f) => {
  // date-time is a format assertion we do not need here; the zod validator checks timestamps
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  return ajv.compile(schema(f));
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const manifest = () => yaml.load(fs.readFileSync(path.join(R, "manifest.yaml"), "utf8"));
const registry = () =>
  yaml.load(fs.readFileSync(path.join(R, "registry/feature_registry.yaml"), "utf8"));
const frontmatters = () =>
  fs.readdirSync(path.join(R, "documents")).map((f) => {
    const m = fs
      .readFileSync(path.join(R, "documents", f), "utf8")
      .match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return { f, meta: yaml.load(m[1]) };
  });

test("the real manifest, registry and document frontmatter satisfy their schemas", ajvOpts, () => {
  const m = validator("bundle-manifest.schema.json");
  assert.ok(m(manifest()), JSON.stringify(m.errors));
  const r = validator("feature-registry.schema.json");
  assert.ok(r(registry()), JSON.stringify(r.errors));
  const d = validator("document-metadata.schema.json");
  for (const { f, meta } of frontmatters()) assert.ok(d(meta), `${f}: ${JSON.stringify(d.errors)}`);
});

test("manifest schema rejects the mistakes the validator rejects", ajvOpts, () => {
  const v = validator("bundle-manifest.schema.json");
  const bad = (mutate) => {
    const m = clone(manifest());
    mutate(m);
    return v(m);
  };
  assert.equal(
    bad((m) => (m.documents[0].id = "DOC-1")),
    false,
    "id format"
  );
  assert.equal(
    bad((m) => (m.documents[0].version = "1.0")),
    false,
    "semver"
  );
  assert.equal(
    bad((m) => (m.documents[0].status = "final")),
    false,
    "status"
  );
  assert.equal(
    bad((m) => (m.documents[0].sha256 = "abc")),
    false,
    "sha256"
  );
  assert.equal(
    bad((m) => delete m.documents[0].sha256),
    false,
    "sha256 required"
  );
  assert.equal(
    bad((m) => (m.documents[0].extra = 1)),
    false,
    "no extra fields"
  );
});

test(
  "manifest schema accepts superseded_by, as the validator and the router now use it",
  ajvOpts,
  () => {
    const v = validator("bundle-manifest.schema.json");
    const m = clone(manifest());
    m.documents[0].status = "superseded";
    m.documents[0].superseded_by = "OKF-0002";
    assert.ok(v(m), JSON.stringify(v.errors));
    m.documents[0].superseded_by = "nope";
    assert.equal(v(m), false);
  }
);

test("document metadata schema rejects bad tags, statuses and ids", ajvOpts, () => {
  const v = validator("document-metadata.schema.json");
  const base = frontmatters()[0].meta;
  const bad = (mutate) => {
    const x = clone(base);
    mutate(x);
    return v(x);
  };
  assert.equal(
    bad((x) => (x.status = "final")),
    false
  );
  assert.equal(
    bad((x) => (x.id = "okf-1")),
    false
  );
  assert.equal(
    bad((x) => (x.tags = ["freeform"])),
    false
  );
  assert.equal(
    bad((x) => (x.version = "v1")),
    false
  );
});

test("a feature registry the schema rejects is one the validator rejects too", ajvOpts, () => {
  const {
    validateFeatureRegistry,
  } = require("../../src/copilot/core/okf/featureRegistryValidator");
  const v = validator("feature-registry.schema.json");
  const mutants = {
    "bad feature id": (r) => (r.features[0].feature_id = "Not A Feature"),
    "bad approval status": (r) => (r.features[0].approval_status = "maybe"),
    "bad version": (r) => (r.features[0].versions[0].version = "banana"),
  };
  for (const [label, mutate] of Object.entries(mutants)) {
    const r = clone(registry());
    mutate(r);
    assert.equal(v(r), false, `schema should reject: ${label}`);
    assert.equal(validateFeatureRegistry(r).valid, false, `validator should reject: ${label}`);
  }
});
