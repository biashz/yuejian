#!/usr/bin/env node
// 统一递增版本号：package.json / tauri.conf.json / Cargo.toml / Cargo.lock 必须同步
// 用法：node scripts/bump-version.mjs [--major|--minor|--set x.y.z]
// 输出：新版本号（stdout 只有版本号，便于 CI 捕获）
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  pkg: resolve(root, "package.json"),
  tauri: resolve(root, "src-tauri/tauri.conf.json"),
  cargo: resolve(root, "src-tauri/Cargo.toml"),
  lock: resolve(root, "src-tauri/Cargo.lock"),
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const VERSION_FIELD = /("version"\s*:\s*")\d+\.\d+\.\d+(")/;
const CARGO_VERSION_FIELD = /(^version\s*=\s*")\d+\.\d+\.\d+(")/m;

function fail(message) {
  console.error(`版本号未修改：${message}`);
  process.exit(1);
}

function nextVersion(current, argv) {
  const setIndex = argv.indexOf("--set");
  if (setIndex !== -1) {
    const value = argv[setIndex + 1];
    if (!value || !SEMVER.test(value)) fail("--set 需要形如 1.2.3 的版本号");
    return value;
  }
  const [major, minor, patch] = current.split(".").map(Number);
  if (argv.includes("--major")) return `${major + 1}.0.0`;
  if (argv.includes("--minor")) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** 只替换第一处匹配；找不到字段说明文件结构与预期不符，直接失败 */
function bumpJson(source, version, label) {
  if (!VERSION_FIELD.test(source)) fail(`${label} 中找不到 version 字段`);
  return source.replace(VERSION_FIELD, `$1${version}$2`);
}

/** Cargo.toml 只改 [package] 段，避免误碰依赖版本 */
function bumpCargoManifest(source, version) {
  const start = source.indexOf("[package]");
  if (start === -1) fail("Cargo.toml 中缺少 [package] 段");
  const end = source.indexOf("\n[", start + 1);
  const section = source.slice(start, end === -1 ? undefined : end);
  if (!CARGO_VERSION_FIELD.test(section)) fail("Cargo.toml 的 [package] 段中找不到版本号");
  const packageName = /(?:^|\n)name\s*=\s*"([^"]+)"/.exec(section)?.[1];
  if (!packageName) fail("Cargo.toml 的 [package] 段缺少 name");
  return {
    content: source.replace(section, section.replace(CARGO_VERSION_FIELD, `$1${version}$2`)),
    packageName,
  };
}

function bumpLockfile(source, packageName, version) {
  // 兼容 CRLF：锁文件中条目名为本包，紧随其后的 version 即应用版本
  const pattern = new RegExp(`(name = "${packageName}"\\r?\\nversion = ")\\d+\\.\\d+\\.\\d+(")`);
  if (!pattern.test(source)) fail("Cargo.lock 中找不到本包条目");
  return source.replace(pattern, `$1${version}$2`);
}

const pkgSource = readFileSync(paths.pkg, "utf8");
const current = JSON.parse(pkgSource).version;
if (!SEMVER.test(current)) fail(`package.json 中的版本号格式异常：${current}`);

const version = nextVersion(current, process.argv.slice(2));
const tauriSource = readFileSync(paths.tauri, "utf8");
const cargoSource = readFileSync(paths.cargo, "utf8");
const lockSource = readFileSync(paths.lock, "utf8");

// 先全部算出结果再落盘，避免中途失败留下半新半旧的版本号
const cargo = bumpCargoManifest(cargoSource, version);
const updates = [
  [paths.pkg, bumpJson(pkgSource, version, "package.json")],
  [paths.tauri, bumpJson(tauriSource, version, "tauri.conf.json")],
  [paths.cargo, cargo.content],
  [paths.lock, bumpLockfile(lockSource, cargo.packageName, version)],
];

for (const [file, content] of updates) writeFileSync(file, content, "utf8");

process.stdout.write(version);
