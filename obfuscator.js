const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const SOURCE = __dirname;
const OUTPUT = path.join(__dirname, "June x on");
const OUTPUT_RESOLVED = path.resolve(OUTPUT);

// Anything in this set is skipped entirely, at EVERY directory level
const EXCLUDE_NAMES = new Set([
  ".git",
  ".github",
  "node_modules",
  "June x on",
  "obfuscator.js",
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".env",
  "README.md"
]);

function processDirectory(source, output) {
  // Belt-and-suspenders: never recurse into the output dir itself,
  // no matter how we got here.
  if (path.resolve(source) === OUTPUT_RESOLVED) {
    console.log(`⨯ Refused to walk into output dir: ${source}`);
    return;
  }

  // Read the source listing BEFORE creating the output dir, so a
  // freshly created output folder can never appear in this listing.
  const items = fs.readdirSync(source);
  fs.mkdirSync(output, { recursive: true });

  for (const item of items) {
    // Excluded at every level, not just the root.
    if (EXCLUDE_NAMES.has(item)) {
      console.log(`⨯ Skipped: ${path.relative(SOURCE, path.join(source, item))}`);
      continue;
    }

    const sourcePath = path.join(source, item);
    const outputPath = path.join(output, item);

    // Never walk into the output directory even if reached indirectly.
    if (path.resolve(sourcePath) === OUTPUT_RESOLVED) {
      console.log(`⨯ Skipped (is output dir): ${item}`);
      continue;
    }

    const stat = fs.statSync(sourcePath);

    if (stat.isSymbolicLink()) {
      console.log(`⨯ Skipped symlink: ${item}`);
      continue;
    }

    if (stat.isDirectory()) {
      processDirectory(sourcePath, outputPath);
      continue;
    }

    if (path.extname(item).toLowerCase() === ".js") {
      const code = fs.readFileSync(sourcePath, "utf8");

      const result = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        numbersToExpressions: true,
        simplify: true,
        stringArray: true,
        stringArrayEncoding: ["base64"],
        rotateStringArray: true,
        unicodeEscapeSequence: false
      });

      fs.writeFileSync(outputPath, result.getObfuscatedCode(), "utf8");
      console.log(`✓ Obfuscated: ${path.relative(SOURCE, sourcePath)}`);
    } else {
      fs.copyFileSync(sourcePath, outputPath);
      console.log(`→ Copied: ${path.relative(SOURCE, sourcePath)}`);
    }
  }
}

// Remove previous build
if (fs.existsSync(OUTPUT)) {
  fs.rmSync(OUTPUT, { recursive: true, force: true });
}

processDirectory(SOURCE, OUTPUT);
