#!/usr/bin/env node

/**
 * scripts/validate-okf.js
 *
 * Validates the OKF (Official Knowledge Framework) bundle registry:
 * - Parses and schema-validates OKF/manifest.yaml
 * - Parses and schema-validates YAML frontmatter on all OKF/documents/*.md
 * - Checks semantic versioning, ID uniqueness, and controlled tag taxonomy
 * - Checks consistency between manifest.yaml and document files (parity & SHA-256)
 * - Supports --fix flag to automatically update SHA-256 hashes in manifest.yaml
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");
const { z } = require("zod");

// 1. ZOD SCHEMAS

const DocumentMetadataSchema = z
  .object({
    id: z.string().regex(/^OKF-[0-9]{4}$/, {
      message: "Document id must match format OKF-XXXX (e.g. OKF-0001)",
    }),
    title: z.string().min(5).max(100),
    description: z.string().min(10).max(300),
    owner: z.string().min(2).max(50),
    status: z.enum(["draft", "approved", "deprecated", "superseded"]),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, {
      message: "Version must be valid SemVer (MAJOR.MINOR.PATCH)",
    }),
    canonical: z.literal(true),
    bundle_id: z.string().regex(/^[a-z0-9-]+$/),
    tags: z
      .array(
        z.string().regex(/^(domain|type|tier|platform):[a-z0-9-]+$/, {
          message:
            "Tags must follow namespace:value format with domain|type|tier|platform prefix",
        })
      )
      .min(1),
    superseded_by: z
      .string()
      .regex(/^OKF-[0-9]{4}$/)
      .nullable()
      .optional(),
    created_at: z.string().datetime({ message: "created_at must be an ISO 8601 timestamp" }),
    updated_at: z.string().datetime({ message: "updated_at must be an ISO 8601 timestamp" }),
  })
  .refine(
    (data) => {
      if (data.status === "superseded") {
        return typeof data.superseded_by === "string" && data.superseded_by.length > 0;
      }
      return true;
    },
    {
      message: "superseded_by is required when status is 'superseded'",
      path: ["superseded_by"],
    }
  );

const ManifestDocumentEntrySchema = z.object({
  id: z.string().regex(/^OKF-[0-9]{4}$/),
  path: z.string().regex(/^documents\/.*\.md$/),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  status: z.enum(["draft", "approved", "deprecated", "superseded"]),
  title: z.string().min(5),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const BundleManifestSchema = z.object({
  bundle_id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(5).max(100),
  description: z.string().min(10).max(500),
  owner: z.string().min(2).max(50),
  status: z.enum(["draft", "approved", "deprecated"]),
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  precedence_rules: z.array(z.string()).min(1),
  documents: z.array(ManifestDocumentEntrySchema),
});

// 2. HELPER FUNCTIONS

function computeSha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function parseFrontmatter(fileContent) {
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error("File is missing standard YAML frontmatter delimiters (---)");
  }
  const rawYaml = match[1];
  const markdownBody = match[2];
  const parsed = yaml.load(rawYaml);
  return { frontmatter: parsed, body: markdownBody };
}

// 3. MAIN VALIDATION ROUTINE

function validateOkfRegistry({ okfDir, fix = false } = {}) {
  const errors = [];
  const warnings = [];
  const rootDir = okfDir || path.resolve(__dirname, "..", "OKF");
  const manifestPath = path.join(rootDir, "manifest.yaml");
  const documentsDir = path.join(rootDir, "documents");

  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      errors: [`Manifest file not found: ${manifestPath}`],
      warnings: [],
      checkedCount: 0,
    };
  }

  let manifestContent = "";
  let manifestData = null;
  try {
    manifestContent = fs.readFileSync(manifestPath, "utf8");
    manifestData = yaml.load(manifestContent);
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to parse manifest.yaml as YAML: ${err.message}`],
      warnings: [],
      checkedCount: 0,
    };
  }

  const manifestResult = BundleManifestSchema.safeParse(manifestData);
  if (!manifestResult.success) {
    for (const issue of manifestResult.error.issues) {
      errors.push(`[manifest.yaml] ${issue.path.join(".")}: ${issue.message}`);
    }
    return { valid: false, errors, warnings, checkedCount: 0 };
  }

  const manifest = manifestResult.data;
  const manifestDocsById = new Map();
  for (const doc of manifest.documents) {
    if (manifestDocsById.has(doc.id)) {
      errors.push(`[manifest.yaml] Duplicate document ID declared in manifest: ${doc.id}`);
    }
    manifestDocsById.set(doc.id, doc);
  }

  if (!fs.existsSync(documentsDir)) {
    errors.push(`Documents directory not found: ${documentsDir}`);
    return { valid: false, errors, warnings, checkedCount: 0 };
  }

  const docFiles = fs
    .readdirSync(documentsDir)
    .filter((file) => file.endsWith(".md"))
    .sort();

  const foundDocIds = new Set();
  let manifestModified = false;

  for (const filename of docFiles) {
    const fullPath = path.join(documentsDir, filename);
    const relPath = `documents/${filename}`;
    const fileContent = fs.readFileSync(fullPath, "utf8");
    const currentSha256 = computeSha256(fileContent);

    let parsed = null;
    try {
      parsed = parseFrontmatter(fileContent);
    } catch (err) {
      errors.push(`[${relPath}] Frontmatter error: ${err.message}`);
      continue;
    }

    const docResult = DocumentMetadataSchema.safeParse(parsed.frontmatter);
    if (!docResult.success) {
      for (const issue of docResult.error.issues) {
        errors.push(`[${relPath}] ${issue.path.join(".")}: ${issue.message}`);
      }
      continue;
    }

    const metadata = docResult.data;

    if (foundDocIds.has(metadata.id)) {
      errors.push(`[${relPath}] Duplicate document ID encountered: ${metadata.id}`);
    }
    foundDocIds.add(metadata.id);

    if (metadata.bundle_id !== manifest.bundle_id) {
      errors.push(
        `[${relPath}] bundle_id mismatch: document specifies '${metadata.bundle_id}', manifest is '${manifest.bundle_id}'`
      );
    }

    const manifestEntry = manifestDocsById.get(metadata.id);
    if (!manifestEntry) {
      errors.push(
        `[${relPath}] Document ${metadata.id} exists on disk but is not registered in manifest.yaml`
      );
      continue;
    }

    if (manifestEntry.path !== relPath) {
      errors.push(
        `[${relPath}] Path mismatch for ${metadata.id}: manifest specifies '${manifestEntry.path}', actual is '${relPath}'`
      );
    }

    if (manifestEntry.version !== metadata.version) {
      errors.push(
        `[${relPath}] Version mismatch for ${metadata.id}: manifest specifies '${manifestEntry.version}', frontmatter has '${metadata.version}'`
      );
    }

    if (manifestEntry.status !== metadata.status) {
      errors.push(
        `[${relPath}] Status mismatch for ${metadata.id}: manifest specifies '${manifestEntry.status}', frontmatter has '${metadata.status}'`
      );
    }

    if (manifestEntry.sha256 !== currentSha256) {
      if (fix) {
        manifestEntry.sha256 = currentSha256;
        manifestModified = true;
        warnings.push(`[${relPath}] Updated SHA-256 in manifest: ${currentSha256}`);
      } else {
        errors.push(
          `[${relPath}] SHA-256 hash mismatch for ${metadata.id}. Expected: ${manifestEntry.sha256}, Actual: ${currentSha256} (run with --fix to update)`
        );
      }
    }
  }

  // Check for orphan entries in manifest that do not exist on disk
  for (const [id, entry] of manifestDocsById.entries()) {
    if (!foundDocIds.has(id)) {
      errors.push(
        `[manifest.yaml] Document ${id} declared at '${entry.path}' does not exist on disk`
      );
    }
  }

  // Check superseded references
  for (const filename of docFiles) {
    const fullPath = path.join(documentsDir, filename);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const { frontmatter } = parseFrontmatter(fs.readFileSync(fullPath, "utf8"));
      if (frontmatter.status === "superseded" && frontmatter.superseded_by) {
        if (!manifestDocsById.has(frontmatter.superseded_by)) {
          errors.push(
            `[documents/${filename}] superseded_by points to unregistered ID: ${frontmatter.superseded_by}`
          );
        }
      }
    } catch {}
  }

  if (fix && manifestModified) {
    fs.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checkedCount: docFiles.length,
  };
}

// 4. CLI RUNNER

if (require.main === module) {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const result = validateOkfRegistry({ fix });

  console.log(`[OKF Validator] Checked ${result.checkedCount} canonical documents.`);

  for (const warn of result.warnings) {
    console.warn(`WARN: ${warn}`);
  }

  if (!result.valid) {
    console.error(`\n[OKF Validator] FAILED with ${result.errors.length} error(s):`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`[OKF Validator] SUCCESS: All OKF documents and manifest are valid.`);
  process.exit(0);
}

module.exports = {
  validateOkfRegistry,
  parseFrontmatter,
  computeSha256,
  DocumentMetadataSchema,
  BundleManifestSchema,
};
