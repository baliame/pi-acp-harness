/** Verify pinned dependencies and the independent SDK integration boundary. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

function sources(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? sources(join(directory, entry.name)) : [join(directory, entry.name)],
	);
}

for (const file of [...sources("src"), ...sources("test"), ...sources("examples")].filter((file) =>
	file.endsWith(".ts"),
)) {
	const content = readFileSync(file, "utf8");
	assert(!/\bimport\s*\(/.test(content), `Inline import: ${file}`);
	assert(
		!/from\s+["'][^"']*(?:pi-tailless|@pi-acp\/frontend|upstream\/|node_modules\/)/.test(content),
		`Foreign source import: ${file}`,
	);
	const visit = (node) => {
		assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `Explicit any: ${file}`);
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true));
}

const metadata = JSON.parse(readFileSync("package.json", "utf8"));
for (const version of Object.values({ ...metadata.dependencies, ...metadata.devDependencies }))
	assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), `Unpinned dependency: ${version}`);
assert(readFileSync("LICENSE", "utf8").includes("MIT"));
const visited = new Set();
function core(file) {
	if (visited.has(file)) return;
	visited.add(file);
	assert(!/[\\/](experimental|capabilities)[\\/]/.test(file), `Optional implementation imported by core: ${file}`);
	for (const match of readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g))
		core(resolve(dirname(file), match[1]));
}
core(resolve("src/index.ts"));
console.log("SDK boundary, exact dependencies and code policy: pass");
