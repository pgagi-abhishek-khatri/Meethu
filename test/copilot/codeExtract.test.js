// test/copilot/codeExtract.test.js
// Comprehensive test suite for Milestone 2: Code-to-MD Context Engine & cAST Syntax Chunker.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractCodeStructure,
  convertCodeToMarkdown,
  chunkCodeAst,
} = require("../../src/copilot/rag/codeExtract");
const { classify } = require("../../src/copilot/rag/config");

describe("Code-to-MD & cAST Syntax Engine (Milestone 2)", () => {
  describe("Config Classification", () => {
    test("correctly identifies code files across major languages", () => {
      assert.strictEqual(classify("app.ts"), "code");
      assert.strictEqual(classify("main.py"), "code");
      assert.strictEqual(classify("server.go"), "code");
      assert.strictEqual(classify("lib.rs"), "code");
      assert.strictEqual(classify("utils.js"), "code");
      assert.strictEqual(classify("kernel.cpp"), "code");
      assert.strictEqual(classify("deploy.sh"), "code");
    });
  });

  describe("JavaScript / TypeScript Structural Extraction", () => {
    const tsCode = `/**
 * Authentication and Token Lifecycle Manager.
 * Handles JWT signing and refresh rotation.
 */
import { sign, verify } from "jsonwebtoken";
const config = require("./authConfig");

export interface UserSession {
  userId: string;
  roles: string[];
}

export class AuthService {
  constructor(private secret: string) {}

  async authenticate(user: string, pass: string): Promise<UserSession> {
    return { userId: user, roles: ["admin"] };
  }
}

export async function rotateRefreshToken(token: string) {
  return "newToken";
}

module.exports = { AuthService, rotateRefreshToken };`;

    test("extracts classes, interfaces, and function signatures", () => {
      const struct = extractCodeStructure(tsCode, "AuthService.ts");
      assert.strictEqual(struct.language, "typescript");
      assert.strictEqual(struct.classes.length, 2); // interface + class
      assert.strictEqual(struct.classes[0].name, "UserSession");
      assert.strictEqual(struct.classes[1].name, "AuthService");
      // the class method counts as a symbol now; a constructor does not
      assert.deepStrictEqual(
        struct.functions.map((f) => f.name),
        ["authenticate", "rotateRefreshToken"]
      );
      assert(struct.fileDoc.includes("Authentication and Token Lifecycle Manager"));
      assert.strictEqual(struct.imports.length, 2);
    });

    test("converts code to Claude Code format Markdown", () => {
      const md = convertCodeToMarkdown(tsCode, "AuthService.ts");
      assert(md.includes("# Module: AuthService.ts"));
      assert(md.includes("## Classes & Types"));
      assert(md.includes("`export class AuthService"));
      assert(md.includes("## Function Signatures"));
      assert(md.includes("`rotateRefreshToken(token: string)`"));
      assert(md.includes("## Dependencies"));
    });
  });

  describe("Python Structural Extraction", () => {
    const pyCode = `# Audio Processing Pipeline
# Fast Fourier Transform & Voice Activity Detection.
import numpy as np
from scipy import signal

class AudioProcessor:
    def __init__(self, sample_rate=16000):
        self.rate = sample_rate

    def process_pcm(self, pcm_buffer):
        return pcm_buffer * 0.5

def detect_voice_activity(audio_chunk):
    return True`;

    test("extracts Python classes and defs", () => {
      const struct = extractCodeStructure(pyCode, "audio_dsp.py");
      assert.strictEqual(struct.language, "python");
      assert.strictEqual(struct.classes.length, 1);
      assert.strictEqual(struct.classes[0].name, "AudioProcessor");
      // Top-level and class methods are tracked in functions
      assert.strictEqual(struct.functions.length, 3);
      assert(struct.functions.some((f) => f.name === "detect_voice_activity"));
      assert(struct.functions.some((f) => f.name === "process_pcm"));
      assert(struct.fileDoc.includes("Audio Processing Pipeline"));
    });
  });

  describe("cAST (Syntax-Aware Chunking)", () => {
    const largeModule = `// Module header
import { db } from "./db";

export class DataStore {
  query(sql: string) {
    return db.execute(sql);
  }
}

export function calculateMetrics(records: any[]) {
  let sum = 0;
  for (const r of records) {
    sum += r.value;
  }
  return sum;
}

export function formatReport(sum: number) {
  return "Total: " + sum;
}`.repeat(10); // expand to test chunking

    test("chunks code preserving symbol anchors, intact headers, and true 1-based line ranges", () => {
      const chunks = chunkCodeAst(largeModule, "DataStore.ts", { targetChars: 400, minChars: 100 });
      assert(chunks.length > 1, "Should create multiple chunks");
      let prevStart = 0;
      for (const chunk of chunks) {
        const m = /\(L(\d+)-L(\d+)\)/.exec(chunk.text);
        assert(chunk.text.includes("// [[symbol:"), "Each chunk must include symbol anchor header");
        assert(m, "Chunk header must include (Lstart-Lend) range");
        const startLine = Number(m[1]);
        const endLine = Number(m[2]);
        assert(startLine >= 1 && endLine >= startLine, "Line range must be valid 1-based bounds");
        assert.strictEqual(chunk.meta.page, startLine, "meta.page must match startLine");
        assert.strictEqual(chunk.meta.endLine, endLine, "meta.endLine must match endLine");
        assert(startLine > prevStart, `Chunk start lines must strictly advance (${prevStart} -> ${startLine})`);
        prevStart = startLine;
        assert(chunk.meta.heading, "Meta heading must be populated");
        assert.strictEqual(chunk.meta.kind, "code");
      }
      assert(prevStart > 1, "Subsequent chunks must not stay stuck at L1");
    });
  });
});

// Phase 4.4: class methods and multi-line signatures are symbols too.
const { test: t44 } = require("node:test");
const assert44 = require("node:assert/strict");
const { extractCodeStructure: extract44 } = require("../../src/copilot/rag/codeExtract");
const names = (s) => s.functions.map((f) => f.name);

t44("JS/TS class and object methods are extracted; control flow is not", () => {
  const s = extract44(
    [
      "export class Billing {",
      "  constructor(db) { this.db = db }",
      "  async chargeCustomer(id, amount) {",
      "    if (amount > 0) {",
      "      for (const x of []) {",
      "        while (false) {}",
      "      }",
      "    }",
      "    return this.db.charge(id, amount)",
      "  }",
      "  static refund(id) { return 1 }",
      "  private get balance(): number { return 0 }",
      "  *items() { yield 1 }",
      "}",
      "const obj = {",
      "  handle(req, res) {",
      "    switch (req) {",
      "    }",
      "  },",
      "};",
    ].join("\n"),
    "billing.ts"
  );
  const got = names(s);
  for (const n of ["chargeCustomer", "refund", "balance", "items", "handle"]) assert44.ok(got.includes(n), n);
  for (const n of ["if", "for", "while", "switch", "return"]) assert44.equal(got.includes(n), false, n);
});

t44("multi-line signatures are joined: JS function, Python def, Go func, Rust fn", () => {
  assert44.deepEqual(
    names(extract44("export function top(\n  a,\n  b\n) {\n  return a + b\n}\n", "a.js")),
    ["top"]
  );
  const py = extract44("class S:\n    def run(self, a,\n            b):\n        return a\n", "s.py");
  assert44.deepEqual(names(py), ["run"]);
  assert44.match(py.functions[0].signature, /run\(self, a,\s*b\)/);
  assert44.deepEqual(names(extract44("func Build(\n\tx int,\n\ty int,\n) int {\n\treturn x\n}\n", "a.go")), ["Build"]);
  assert44.deepEqual(names(extract44("pub async fn load(\n    path: &str,\n) -> Result<()> {\n}\n", "a.rs")), ["load"]);
});

t44("a call that merely spans lines is not a definition", () => {
  const s = extract44("run(\n  a,\n  b\n);\nconsole.log(\n  1\n);\n", "a.js");
  assert44.deepEqual(names(s), []);
});

t44("single-line extraction is unchanged", () => {
  const s = extract44("function a(x) {}\nconst b = (y) => y;\nclass C {}\n", "a.js");
  assert44.deepEqual(names(s), ["a", "b"]);
  assert44.deepEqual(s.classes.map((c) => c.name), ["C"]);
});
