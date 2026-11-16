import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesFilters, parseUnixListDate, wildcardToRegExp, type RemoteFile } from "../src/file-backup.ts";
import type { FileSourceConfig } from "../src/types.ts";

describe("wildcardToRegExp", () => {
  it("so * e curinga; o resto e literal e sem diferenciar maiusculas", () => {
    const re = wildcardToRegExp("*.sql.gz");
    assert.ok(re.test("dump.sql.gz"));
    assert.ok(re.test("DUMP.SQL.GZ"));
    assert.ok(!re.test("dump.sqlxgz"), "o ponto nao pode virar curinga de regex");
    assert.ok(!re.test("dump.sql.gz.bak"));
    assert.ok(wildcardToRegExp("backup(1)+[a].zip").test("backup(1)+[a].zip"));
  });
});

describe("matchesFilters", () => {
  const source = (over: Partial<FileSourceConfig>): FileSourceConfig => ({
    protocol: "sftp",
    host: "h",
    port: 22,
    user: "u",
    password: "p",
    remoteDir: "/",
    pattern: "*",
    nameContains: null,
    modifiedWithinDays: null,
    secure: false,
    ...over,
  });
  const file = (name: string, mtimeMs = Date.now()): RemoteFile => ({ name, relativePath: name, size: 1, mtimeMs });

  it("sem filtros, aceita tudo", () => {
    assert.ok(matchesFilters(file("qualquer.txt"), source({}), null));
  });

  it("combina padrao, trecho do nome e data (todos precisam bater)", () => {
    const s = source({ pattern: "*.zip", nameContains: "Completo" });
    const cutoff = Date.now() - 86400_000;
    assert.ok(matchesFilters(file("backup-completo.zip"), s, cutoff));
    assert.ok(!matchesFilters(file("backup-parcial.zip"), s, cutoff));
    assert.ok(!matchesFilters(file("backup-completo.tar"), s, cutoff));
    assert.ok(!matchesFilters(file("backup-completo.zip", cutoff - 1), s, cutoff));
  });
});

describe("parseUnixListDate (formato do ls -l em FTP)", () => {
  const now = new Date(2026, 10, 13, 9, 0); // 13/nov/2026 09:00

  it("data recente sem ano usa o ano atual", () => {
    assert.equal(parseUnixListDate("Nov 12 23:15", now), new Date(2026, 10, 12, 23, 15).getTime());
  });

  it("data recente que cairia no futuro e do ano anterior", () => {
    assert.equal(parseUnixListDate("Dec 20 10:00", now), new Date(2025, 11, 20, 10, 0).getTime());
  });

  it("data antiga com ano e sem hora", () => {
    assert.equal(parseUnixListDate("Mar  5  2024", now), new Date(2024, 2, 5).getTime());
  });

  it("formatos desconhecidos devolvem null", () => {
    assert.equal(parseUnixListDate("2026-11-12", now), null);
    assert.equal(parseUnixListDate("Foo 12 10:00", now), null);
    assert.equal(parseUnixListDate("", now), null);
  });
});

describe("wildcardToRegExp: so * e curinga", () => {
  it("? e literal", () => {
    const re = wildcardToRegExp("dump?.sql");
    assert.ok(re.test("dump?.sql"));
    assert.ok(!re.test("dum.sql"));
    assert.ok(!re.test("dump1.sql"));
  });
});
