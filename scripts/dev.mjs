/**
 * 构建与启动 Tauri 的统一入口。
 * 本机全局 RUSTUP_HOME 指向不可写目录，因此优先使用工作区内安装的工具链；
 * 其他环境若没有 .toolchains，则沿用系统默认 Rust。
 *
 * 所有构建期下载的依赖都收敛到项目根目录内：
 *   .toolchains/  Rust 工具链与 cargo 依赖
 *   .cache/       npm 与 Tauri 打包工具缓存
 *
 * 说明：本机上 `tauri dev` 启动 WebView2 时偶发 COM 初始化失败，
 * 因此 dev 模式改为「增量构建 + 直接运行可执行文件」，行为与正式运行一致。
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const cacheDir = path.join(root, ".cache");
const rustupHome = path.join(root, ".toolchains", "rustup");
const cargoHome = path.join(root, ".toolchains", "cargo");

const env = { ...process.env };
// 构建期下载的依赖与工具统一放入项目目录，避免污染用户目录
env.npm_config_cache = path.join(cacheDir, "npm");
env.CARGO_TARGET_DIR = path.join(root, "src-tauri", "target");

const localToolchain = path.join(rustupHome, "toolchains", "stable-x86_64-pc-windows-msvc");
if (existsSync(localToolchain)) {
  env.RUSTUP_HOME = rustupHome;
  env.CARGO_HOME = cargoHome;
  // 显式指定工具链，避免 rustup 默认配置丢失后无法启动
  env.RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc";
  const localBin = path.join(cargoHome, "bin");
  if (existsSync(localBin)) {
    env.PATH = `${localBin}${path.delimiter}${env.PATH || ""}`;
  }
}

const isWindows = process.platform === "win32";
const cli = path.join(root, "node_modules", ".bin", isWindows ? "tauri.cmd" : "tauri");
const args = process.argv.slice(2);
const mode = args[0] || "dev";

function exitWith(code) {
  process.exit(code ?? 0);
}

/**
 * Tauri 打包器会把 NSIS/WiX 下载到系统缓存目录（`%LOCALAPPDATA%\tauri`）。
 * 该路径无法通过环境变量改写，因此打包前临时建立一个目录联接指向项目 `.cache/tauri`，
 * 打包结束再撤销联接，保证依赖实际落在项目内、系统目录不留内容。
 */
const bundlerCacheLink = path.join(process.env.LOCALAPPDATA || "", "tauri");

function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function attachBundlerCache() {
  if (!isWindows || !process.env.LOCALAPPDATA) return false;
  const target = path.join(cacheDir, "tauri");
  mkdirSync(target, { recursive: true });

  // 已存在的联接视为可复用，不做任何删除
  if (isLink(bundlerCacheLink)) return true;
  if (existsSync(bundlerCacheLink)) {
    console.warn("系统缓存目录已存在且不是联接，本次打包仍使用系统目录");
    return false;
  }

  try {
    symlinkSync(target, bundlerCacheLink, "junction");
    return true;
  } catch (err) {
    console.warn(`无法创建打包缓存联接：${err.message}`);
    return false;
  }
}

function detachBundlerCache(attached) {
  if (!attached) return;
  try {
    // rmdir 只移除联接本身，不会删除项目内的实际文件
    rmdirSync(bundlerCacheLink);
  } catch {
    /* 联接不存在时忽略 */
  }
}

/** 列出打包产物，方便直接找到安装包 */
function listBundles() {
  const dir = path.join(root, "src-tauri", "target", "release", "bundle");
  if (!existsSync(dir)) return;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (!/\.(sig|json|txt)$/i.test(name)) {
        console.log(`  ${path.relative(root, full)}`);
      }
    }
  };
  console.log("安装包产物：");
  walk(dir);
}

/**
 * 启动已构建的可执行文件。
 * 当前终端环境会限制子进程创建 WebView2（ERROR_BUSY），
 * 因此统一交给 PowerShell 的 Start-Process 以独立进程启动。
 */
function launchApp(attempt = 1) {
  const exe = path.join(root, "src-tauri", "target", "debug", isWindows ? "yuejian.exe" : "yuejian");
  const launcher = isWindows
    ? spawn("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath "${exe}"`], { stdio: "inherit", env })
    : spawn(exe, [], { stdio: "ignore", detached: true, env, cwd: root });
  launcher.on("exit", (code) => {
    if (code !== 0 && attempt < 3) {
      setTimeout(() => launchApp(attempt + 1), 3000);
      return;
    }
    if (code === 0) {
      console.log("阅笺已启动");
      return exitWith(0);
    }
    exitWith(code ?? 1);
  });
}

function runTauri(tauriArgs, onSuccess) {
  const child = spawn(cli, tauriArgs, { stdio: "inherit", env, shell: isWindows });
  child.on("exit", (code) => {
    if (code !== 0) return exitWith(code ?? 1);
    onSuccess();
  });
}

if (mode === "dev") {
  runTauri(["build", "--debug", "--no-bundle"], () => {
    // 刚生成的可执行文件可能仍被系统扫描占用，稍等再启动
    setTimeout(launchApp, 3000);
  });
} else if (mode === "bundle") {
  // 产出当前平台的安装包：Windows=NSIS，Linux=deb/AppImage，macOS=app/dmg
  const linked = attachBundlerCache();
  runTauri(["build", ...args.slice(1)], () => {
    detachBundlerCache(linked);
    listBundles();
    exitWith(0);
  });
} else {
  runTauri(args, () => exitWith(0));
}
