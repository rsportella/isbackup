import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

function load(yaml: string) {
  const file = path.join(dir, `c${Math.random().toString(16).slice(2)}.yaml`);
  fs.writeFileSync(file, yaml);
  return loadConfig(file);
}

describe("loadConfig: nome do job", () => {
  it("aceita nomes validos e monta a pasta de saida por job", () => {
    const [job] = load("jobs:\n  - name: Prod_1\n    schedule: daily\n    user: u\n    password: x\n");
    assert.equal(job.outputDir, path.join(dir, "backups", "Prod_1"));
  });

  for (const bad of ["meu job", "../fora", "a/b", "a;rm -rf ~", "job.1"]) {
    it(`recusa "${bad}"`, () => {
      assert.throws(
        () => load(`jobs:\n  - name: "${bad}"\n    schedule: daily\n    user: u\n    password: x\n`),
        /nome invalido/,
      );
    });
  }
});
