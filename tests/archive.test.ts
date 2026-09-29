import { gunzipSync, gzipSync } from 'node:zlib';

import { expect } from 'chai';

import { readTarGzModule } from '../src/archive';
import type { ModuleFileLimits } from '../src/archive';
import { RemoteSourceError } from '../src/remote-errors';
import { tarGz } from './tar-fixture';

const limits: ModuleFileLimits = { maximumFileBytes: 1024, maximumModuleBytes: 4096, maximumModuleFiles: 5, maximumArchiveBytes: 64 * 1024 };

const failure = async (promise: Promise<unknown>): Promise<RemoteSourceError> => {
	try {
		await promise;
	} catch (error) {
		expect(error).to.be.instanceOf(RemoteSourceError);
		return error as RemoteSourceError;
	}
	throw new Error('expected the archive to be refused');
};

describe('tar.gz module archives', () => {
	it('keeps only visible top-level .tf files inside the subdirectory', async () => {
		const archive = await tarGz([
			{ name: 'outside.tf', content: 'variable "outside" {}' },
			{ name: 'modules/vpc/', type: 'directory' },
			{ name: 'modules/vpc/variables.tf', content: 'variable "name" {}' },
			{ name: './modules/vpc/main.tf', content: 'resource "x" "y" {}' },
			{ name: 'modules/vpc/.hidden.tf', content: 'variable "hidden" {}' },
			{ name: 'modules/vpc/README.md', content: '# vpc' },
			{ name: 'modules/vpc/nested/inner.tf', content: 'variable "inner" {}' },
			{ name: 'modules/vpc/link.tf', type: 'symlink', linkname: '../../outside.tf' },
			{ name: 'modules/vpc/hard.tf', type: 'link', linkname: 'outside.tf' },
			{ name: 'modules/vpc/../vpc/escape.tf', content: 'variable "escape" {}' }
		]);
		const files = await readTarGzModule(archive, 'modules/vpc', 'vpc', limits);
		expect([...files.keys()]).to.deep.equal(['main.tf', 'variables.tf']);
		expect(files.get('variables.tf')?.toString('utf8')).to.equal('variable "name" {}');
	});

	it('reads the archive root and names longer than a ustar header holds', async () => {
		const directory = `${'d'.repeat(120)}/${'e'.repeat(120)}`;
		const archive = await tarGz([{ name: 'main.tf', content: 'a' }, { name: `${directory}/${'f'.repeat(150)}.tf`, content: 'b' }]);
		expect([...(await readTarGzModule(archive, '', 'root', limits)).keys()]).to.deep.equal(['main.tf']);
		expect([...(await readTarGzModule(archive, directory, 'long', limits)).keys()]).to.deep.equal([`${'f'.repeat(150)}.tf`]);
	});

	it('reports a subdirectory the archive does not hold', async () => {
		const archive = await tarGz([{ name: 'modules/vpc/main.tf', content: '' }]);
		expect(await readTarGzModule(archive, 'modules/vpc', 'vpc', limits)).to.have.property('size', 1);
		const error = await failure(readTarGzModule(archive, 'modules/eks', 'vpc', limits));
		expect(error.code).to.equal('SubdirectoryMissing');
		expect(error.message).to.equal('subdirectory modules/eks does not exist in vpc');
	});

	it('refuses data that is not a readable tar.gz', async () => {
		expect((await failure(readTarGzModule(Buffer.from('PK\u0003\u0004'), '', 'zip', limits))).message).to.equal('zip is not a gzip-compressed tar archive');
		const truncated = gzipSync(gunzipSync(await tarGz([{ name: 'main.tf', content: 'x'.repeat(600) }])).subarray(0, 700));
		expect((await failure(readTarGzModule(truncated, '', 'truncated', limits))).code).to.equal('ArchiveMalformed');
		const corrupt = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(40, 7)]);
		expect((await failure(readTarGzModule(corrupt, '', 'corrupt', limits))).code).to.equal('ArchiveMalformed');
	});

	it('stops at each limit', async () => {
		const large = await tarGz([{ name: 'main.tf', content: 'x'.repeat(2048) }]);
		expect((await failure(readTarGzModule(large, '', 'large', limits))).message).to.equal('main.tf in large is 2048 bytes; at most 1024 are read');
		const many = await tarGz(Array.from({ length: 6 }, (_, index) => ({ name: `file${index}.tf`, content: '' })));
		expect((await failure(readTarGzModule(many, '', 'many', limits))).message).to.equal('many has more than 5 Terraform files at the top level');
		const total = await tarGz(Array.from({ length: 5 }, (_, index) => ({ name: `file${index}.tf`, content: 'x'.repeat(1000) })));
		expect((await failure(readTarGzModule(total, '', 'total', limits))).message).to.equal('total has more than 4096 bytes of Terraform files');
		const bomb = await tarGz([{ name: 'padding.bin', content: '\0'.repeat(128 * 1024) }]);
		expect((await failure(readTarGzModule(bomb, '', 'bomb', limits))).message).to.equal('bomb decompresses to more than 65536 bytes');
	});
});
