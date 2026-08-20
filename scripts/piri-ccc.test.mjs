import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("./piri-ccc.sh", import.meta.url));
const sourceLauncher = fileURLToPath(new URL("../pi-test.sh", import.meta.url));

async function createFixture(
	shebang = "#!/usr/bin/env node",
	body = "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
) {
	const root = await mkdtemp(join(tmpdir(), "piri-ccc-"));
	const cli = join(root, "fake-piri.mjs");
	await writeFile(cli, `${shebang}\n${body}\n`);
	await chmod(cli, 0o700);
	return { root, cli };
}

function runWrapper(cli, args = [], environment = {}) {
	return spawnSync(wrapper, args, {
		encoding: "utf8",
		env: {
			...process.env,
			PIRI_CLI_PATH: cli,
			PIRI_DEFAULT_MODEL: "",
			PIRI_DEFAULT_THINKING: "",
			PIRI_BOOTSTRAP_CONTEXT_FILE: "",
			PIRI_BOOTSTRAP_MAX_BYTES: "",
			...environment,
		},
	});
}

test("adds validated ccc defaults and a private bootstrap context file", async () => {
	const { root, cli } = await createFixture();
	try {
		const bootstrap = join(root, "memory.md");
		await writeFile(bootstrap, "bounded memory\n", { mode: 0o600 });
		const result = runWrapper(cli, ["--mode", "rpc"], {
			PIRI_DEFAULT_MODEL: "kimi-coding/k3",
			PIRI_DEFAULT_THINKING: "max",
			PIRI_BOOTSTRAP_CONTEXT_FILE: bootstrap,
			PIRI_BOOTSTRAP_MAX_BYTES: "1024",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), [
			"--model",
			"kimi-coding/k3",
			"--thinking",
			"max",
			"--append-system-prompt",
			bootstrap,
			"--mode",
			"rpc",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("lets explicit ccc session selections override launcher defaults", async () => {
	const { root, cli } = await createFixture();
	try {
		const result = runWrapper(cli, ["--model", "zai/glm-5.2", "--thinking", "high"], {
			PIRI_DEFAULT_MODEL: "kimi-coding/k3",
			PIRI_DEFAULT_THINKING: "max",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), ["--model", "zai/glm-5.2", "--thinking", "high"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolves an env shebang interpreter from PATH when env is unavailable", async () => {
	const root = await mkdtemp(join(tmpdir(), "piri-ccc-missing-env-"));
	const missingEnv = join(root, "missing", "env");
	const cli = join(root, "fake-piri.mjs");
	await writeFile(
		cli,
		`#!${missingEnv} node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
	);
	await chmod(cli, 0o700);
	try {
		const result = runWrapper(cli, ["--mode", "rpc"]);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), ["--mode", "rpc"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("forwards safe env -S interpreter arguments without invoking env", async () => {
	const { root, cli } = await createFixture(
		"#!/definitely/missing/env -S node --no-warnings",
		"process.stdout.write(JSON.stringify({ execArgv: process.execArgv, args: process.argv.slice(2) }));",
	);
	try {
		const result = runWrapper(cli, ["--mode", "rpc"]);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			execArgv: ["--no-warnings"],
			args: ["--mode", "rpc"],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects shell syntax in env -S arguments without executing it", async () => {
	const root = await mkdtemp(join(tmpdir(), "piri-ccc-unsafe-shebang-"));
	const marker = join(root, "executed");
	const cli = join(root, "fake-piri.mjs");
	await writeFile(
		cli,
		`#!/definitely/missing/env -S node --require=$(touch\${IFS}${marker})\nprocess.exit(0);\n`,
	);
	await chmod(cli, 0o700);
	try {
		const result = runWrapper(cli);

		assert.equal(result.status, 2);
		assert.match(result.stderr, /env -S argument is unsupported/);
		await assert.rejects(access(marker));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pi-test invokes the tsx module through node instead of its env shebang", async () => {
	const root = await mkdtemp(join(tmpdir(), "piri-pi-test-"));
	const launcher = join(root, "pi-test.sh");
	const binDirectory = join(root, "node_modules", ".bin");
	const tsxDirectory = join(root, "node_modules", "tsx", "dist");
	await copyFile(sourceLauncher, launcher);
	await chmod(launcher, 0o700);
	await mkdir(binDirectory, { recursive: true });
	await mkdir(tsxDirectory, { recursive: true });
	const bin = join(binDirectory, "tsx");
	await writeFile(bin, `#!${root}/missing/env node\nprocess.exit(91);\n`);
	await chmod(bin, 0o700);
	await writeFile(
		join(tsxDirectory, "cli.mjs"),
		"process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
	);
	try {
		const result = spawnSync("bash", [launcher, "--mode", "rpc"], {
			encoding: "utf8",
			env: process.env,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), [
			"--tsconfig",
			join(root, "tsconfig.json"),
			join(root, "packages", "coding-agent", "src", "cli.ts"),
			"--mode",
			"rpc",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects bootstrap context visible to group or other users", async () => {
	const { root, cli } = await createFixture();
	try {
		const bootstrap = join(root, "memory.md");
		await writeFile(bootstrap, "memory\n", { mode: 0o644 });
		await chmod(bootstrap, 0o644);
		const result = runWrapper(cli, [], { PIRI_BOOTSTRAP_CONTEXT_FILE: bootstrap });

		assert.equal(result.status, 2);
		assert.match(result.stderr, /must not be accessible by group or other users/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects symlinked and oversized bootstrap context files", async () => {
	const { root, cli } = await createFixture();
	try {
		const target = join(root, "memory.md");
		const link = join(root, "memory-link.md");
		await writeFile(target, "memory\n", { mode: 0o600 });
		await symlink(target, link);

		const symlinkResult = runWrapper(cli, [], { PIRI_BOOTSTRAP_CONTEXT_FILE: link });
		assert.equal(symlinkResult.status, 2);
		assert.match(symlinkResult.stderr, /must not be a symlink/);

		const oversizedResult = runWrapper(cli, [], {
			PIRI_BOOTSTRAP_CONTEXT_FILE: target,
			PIRI_BOOTSTRAP_MAX_BYTES: "4",
		});
		assert.equal(oversizedResult.status, 2);
		assert.match(oversizedResult.stderr, /exceeds PIRI_BOOTSTRAP_MAX_BYTES/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
