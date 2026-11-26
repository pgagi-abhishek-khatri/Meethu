// Phase 5.3: a feature that cites an OKF document must cite one that exists in the manifest.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const { validateFeatureRegistry } = require("../../src/copilot/core/okf/featureRegistryValidator");

const REAL = path.resolve(__dirname, "../../OKF");
const load = () =>
  yaml.load(fs.readFileSync(path.join(REAL, "registry/feature_registry.yaml"), "utf8"));
const manifestIds = () =>
  yaml.load(fs.readFileSync(path.join(REAL, "manifest.yaml"), "utf8")).documents.map((d) => d.id);

test("without manifest ids the validator behaves as before", () => {
  assert.equal(validateFeatureRegistry(load()).valid, true);
});

test("the shipped registry passes against the real manifest", () => {
  const res = validateFeatureRegistry(load(), { manifestIds: manifestIds() });
  assert.deepEqual(res.errors, []);
});

test("a dangling OKF id is an error and names the feature and the id", () => {
  const data = load();
  const feat = data.features.find((f) => f.sources?.some((s) => s.document_id === "OKF-0002"));
  feat.sources[0].document_id = "OKF-0999";
  const res = validateFeatureRegistry(data, { manifestIds: manifestIds() });
  assert.equal(res.valid, false);
  assert.ok(
    res.errors.some((e) => e.includes("OKF-0999") && e.includes(feat.feature_id)),
    res.errors.join("\n")
  );
});

test("a project document id is allowed but flagged as unverifiable", () => {
  const res = validateFeatureRegistry(load(), { manifestIds: manifestIds() });
  assert.ok(
    res.warnings.some((w) => w.includes("client_requirements_v2") && /not an OKF document/i.test(w))
  );
});

test("a dangling id inside a version's sources is caught too", () => {
  const data = load();
  const feat = data.features.find((f) =>
    f.versions?.some((v) => v.sources?.some((s) => s.document_id === "OKF-0002"))
  );
  const ver = feat.versions.find((v) => v.sources?.some((s) => s.document_id === "OKF-0002"));
  ver.sources[0].document_id = "OKF-0777";
  const res = validateFeatureRegistry(data, { manifestIds: manifestIds() });
  assert.ok(res.errors.some((e) => e.includes("OKF-0777")));
});
