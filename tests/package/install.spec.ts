import {expect} from 'chai';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const binDir = path.join(repo, 'node_modules', '.bin');

interface Result {
	status: number | null;
	output: string;
}

/**
 * Runs a command to completion.
 *
 * @param command - The executable to run.
 * @param args - Its arguments.
 * @param cwd - The directory to run it in.
 * @returns Its exit status, and its standard output and error combined.
 */
function exec(command: string, args: string[], cwd: string): Result {
	const result = spawnSync(command, args, {cwd, encoding: 'utf8'});
	if (result.error) throw result.error;
	return {status: result.status, output: `${result.stdout}${result.stderr}`};
}

/**
 * Runs a command and fails if it exits non-zero.
 *
 * @param command - The executable to run.
 * @param args - Its arguments.
 * @param cwd - The directory to run it in.
 * @returns Its standard output and error combined.
 */
function execOk(command: string, args: string[], cwd: string): string {
	const result = exec(command, args, cwd);
	expect(result.status).to.equal(0, result.output);
	return result.output;
}

/**
 * Packs the package into a tarball.
 *
 * @param destination - An empty directory to write the tarball to.
 * @returns The tarball's path.
 */
async function pack(destination: string): Promise<string> {
	execOk('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], repo);
	const tarballs = (await fs.readdir(destination)).filter(name => name.endsWith('.tgz'));
	expect(tarballs).to.have.lengthOf(1);
	return path.join(destination, tarballs[0]);
}

describe('published package', function () {
	this.timeout(120000);

	let work: string;
	let consumer: string;
	let bin: string;

	before(async () => {
		work = await fs.mkdtemp(path.join(os.tmpdir(), 'tghclparser-package-'));
		const tarball = await pack(work);
		consumer = path.join(work, 'consumer');
		await fs.cp(path.join(here, 'consumer'), consumer, {recursive: true});
		const manifest = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
		const devDependencies = {'@types/node': manifest.devDependencies['@types/node']};
		await fs.writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({private: true, devDependencies}, null, '\t')}\n`);
		execOk('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], consumer);
		bin = path.join(consumer, 'node_modules', '.bin', 'tghclp');
	});

	after(async () => {
		if (work) await fs.rm(work, {recursive: true, force: true});
	});

	it('validates a valid unit through the installed bin', () => {
		execOk(bin, ['hcl', 'validate'], path.join(consumer, 'valid'));
	});

	it('reports invalid HCL through the installed bin and exits 1', () => {
		const result = exec(bin, ['hcl', 'validate'], path.join(consumer, 'invalid'));
		expect(result.status).to.equal(1, result.output);
		expect(result.output).to.contain('HCL validation error');
	});

	it('exports the same names from require and import', async () => {
		const {cjsNames, esmNames} = await import(pathToFileURL(path.join(consumer, 'exports.mjs')).href);
		expect(cjsNames).to.have.length.greaterThan(0);
		expect(esmNames).to.deep.equal(cjsNames);
	});

	it('type-checks ESM and CJS consumers under nodenext resolution', () => {
		execOk(path.join(binDir, 'tsc'), ['--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', 'consumer.mts', 'consumer.cts'], consumer);
	});

	it('type-checks an ESM consumer under bundler resolution', () => {
		execOk(path.join(binDir, 'tsc'), ['--noEmit', '--strict', '--module', 'esnext', '--moduleResolution', 'bundler', 'consumer.mts'], consumer);
	});

	it('passes publint', () => {
		execOk(path.join(binDir, 'publint'), ['--strict', '--pack', 'false', path.join(consumer, 'node_modules', 'tghclparser')], repo);
	});
});
