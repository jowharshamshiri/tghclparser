/*
 * A TypeScript port of the IP address parsing OpenTofu keeps in internal/ipaddr, a copy of Go 1.16's net package
 * (Copyright The Go Authors, BSD-style licence), as Terragrunt v1.2.2 vendors it, and of the parts of net.IP, net.IPNet
 * and github.com/apparentlymart/go-cidr (Copyright Martin Atkins, MIT licence) that cidrcontains uses.
 *
 * Unlike Go 1.17 and later, this parser takes an IPv4 octet with leading zeros as decimal, so "010.0.0.1" is 10.0.0.1.
 */

/** An address as Go holds one: 4 bytes, or 16, of which an IPv4 address mapped into IPv6 is also an IPv4 one. */
export type IP = Uint8Array;

export interface IPNet {
	ip: IP;
	mask: Uint8Array;
}

const v4InV6Prefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];
const big = 0xffffff;

function ipv4(a: number, b: number, c: number, d: number): IP {
	return Uint8Array.from([...v4InV6Prefix, a, b, c, d]);
}

/** Decimal digits from the start of s: their value, how many there were, and whether there were any. */
function dtoi(s: string): [number, number, boolean] {
	let n = 0;
	let index = 0;
	for (; index < s.length && s[index] >= '0' && s[index] <= '9'; index++) {
		n = n * 10 + (s.charCodeAt(index) - 48);
		if (n >= big) return [big, index, false];
	}
	return index === 0 ? [0, 0, false] : [n, index, true];
}

/** Hexadecimal digits from the start of s, as {@link dtoi} reads decimal ones. */
function xtoi(s: string): [number, number, boolean] {
	let n = 0;
	let index = 0;
	for (; index < s.length; index++) {
		const digit = parseInt(s[index], 16);
		if (Number.isNaN(digit)) break;
		n = n * 16 + digit;
		if (n >= big) return [0, index, false];
	}
	return index === 0 ? [0, index, false] : [n, index, true];
}

function parseIPv4(text: string): IP | undefined {
	let s = text;
	const parts: number[] = [];
	for (let index = 0; index < 4; index++) {
		if (s.length === 0) return undefined;
		if (index > 0) {
			if (s[0] !== '.') return undefined;
			s = s.slice(1);
		}
		const [n, count, ok] = dtoi(s);
		if (!ok || n > 0xff) return undefined;
		s = s.slice(count);
		parts.push(n);
	}
	if (s.length !== 0) return undefined;
	return ipv4(parts[0], parts[1], parts[2], parts[3]);
}

function parseIPv6(text: string): IP | undefined {
	let s = text;
	const ip = new Uint8Array(16);
	let ellipsis = -1;
	if (s.length >= 2 && s[0] === ':' && s[1] === ':') {
		ellipsis = 0;
		s = s.slice(2);
		if (s.length === 0) return ip;
	}
	let index = 0;
	while (index < 16) {
		const [n, count, ok] = xtoi(s);
		if (!ok || n > 0xffff) return undefined;
		if (count < s.length && s[count] === '.') {
			if (ellipsis < 0 && index !== 12) return undefined;
			if (index + 4 > 16) return undefined;
			const embedded = parseIPv4(s);
			if (!embedded) return undefined;
			ip.set(embedded.subarray(12), index);
			s = '';
			index += 4;
			break;
		}
		ip[index] = n >> 8;
		ip[index + 1] = n & 0xff;
		index += 2;
		s = s.slice(count);
		if (s.length === 0) break;
		if (s[0] !== ':' || s.length === 1) return undefined;
		s = s.slice(1);
		if (s[0] === ':') {
			if (ellipsis >= 0) return undefined;
			ellipsis = index;
			s = s.slice(1);
			if (s.length === 0) break;
		}
	}
	if (s.length !== 0) return undefined;
	if (index < 16) {
		if (ellipsis < 0) return undefined;
		const n = 16 - index;
		for (let j = index - 1; j >= ellipsis; j--) ip[j + n] = ip[j];
		for (let j = ellipsis + n - 1; j >= ellipsis; j--) ip[j] = 0;
	} else if (ellipsis >= 0) {
		return undefined;
	}
	return ip;
}

/** Go's ParseIP: an IPv4 or IPv6 address, or undefined. */
export function parseIP(s: string): IP | undefined {
	for (const character of s) {
		if (character === '.') return parseIPv4(s);
		if (character === ':') return parseIPv6(s);
	}
	return undefined;
}

/** Go's CIDRMask: a mask of the leading ones, or Go's nil mask, here empty, for a length the address cannot have. */
function cidrMask(ones: number, bits: number): Uint8Array {
	if ((bits !== 32 && bits !== 128) || ones < 0 || ones > bits) return new Uint8Array(0);
	const mask = new Uint8Array(bits / 8);
	let remaining = ones;
	for (let index = 0; index < mask.length; index++) {
		if (remaining >= 8) {
			mask[index] = 0xff;
			remaining -= 8;
			continue;
		}
		mask[index] = ~(0xff >> remaining) & 0xff;
		remaining = 0;
	}
	return mask;
}

const allFF = (bytes: Uint8Array): boolean => bytes.every(byte => byte === 0xff);
const isV4InV6 = (ip: IP): boolean => ip.length === 16 && v4InV6Prefix.every((byte, index) => ip[index] === byte);

/** Go's IP.To4: the 4 bytes of an IPv4 address, mapped or not, or undefined for any other. */
export function to4(ip: IP): IP | undefined {
	if (ip.length === 4) return ip;
	return isV4InV6(ip) ? ip.subarray(12) : undefined;
}

/** Go's IP.Mask. */
function maskIP(ip: IP, maskBytes: Uint8Array): IP | undefined {
	let mask = maskBytes;
	let address = ip;
	if (mask.length === 16 && address.length === 4 && allFF(mask.subarray(0, 12))) mask = mask.subarray(12);
	if (mask.length === 4 && address.length === 16 && isV4InV6(address)) address = address.subarray(12);
	if (mask.length !== address.length) return undefined;
	return Uint8Array.from(address, (byte, index) => byte & mask[index]);
}

/** Go's ParseCIDR: the network of an address with a prefix length, or an error naming the text. */
export function parseCIDR(s: string): IPNet {
	const slash = s.indexOf('/');
	const refused = new Error(`invalid CIDR address: ${s}`);
	if (slash < 0) throw refused;
	const address = s.slice(0, slash);
	const prefix = s.slice(slash + 1);
	let length = 4;
	let ip = parseIPv4(address);
	if (!ip) {
		length = 16;
		ip = parseIPv6(address);
	}
	const [n, count, ok] = dtoi(prefix);
	if (!ip || !ok || count !== prefix.length || n < 0 || n > 8 * length) throw refused;
	const mask = cidrMask(n, 8 * length);
	return { ip: maskIP(ip, mask)!, mask };
}

/** Go's IPNet.Contains. */
export function contains(network: IPNet, ip: IP): boolean {
	let networkIP = to4(network.ip);
	let mask = network.mask;
	if (!networkIP) {
		networkIP = network.ip;
		if (networkIP.length !== 16) return false;
	}
	if (mask.length === 4) {
		if (networkIP.length !== 4) return false;
	} else if (mask.length === 16 && networkIP.length === 4) {
		mask = mask.subarray(12);
	}
	const address = to4(ip) ?? ip;
	if (address.length !== networkIP.length) return false;
	for (let index = 0; index < address.length; index++) {
		if ((networkIP[index] & mask[index]) !== (address[index] & mask[index])) return false;
	}
	return true;
}

/** go-cidr's AddressRange: the first and last addresses of a network. */
export function addressRange(network: IPNet): [IP, IP] {
	const first = network.ip;
	const ones = [...network.mask].reduce((count, byte) => count + byte.toString(2).replace(/0/gu, '').length, 0);
	const bits = network.mask.length * 8;
	if (ones === bits) return [first, Uint8Array.from(first)];
	const hostBits = bits - ones;
	let value = 0n;
	for (const byte of first) value = (value << 8n) | BigInt(byte);
	const last = value | ((1n << BigInt(hostBits)) - 1n);
	const width = first.length === 4 ? 4 : 16;
	const out = new Uint8Array(width);
	let rest = last;
	for (let index = width - 1; index >= 0; index--) {
		out[index] = Number(rest & 0xffn);
		rest >>= 8n;
	}
	return [first, out];
}

/** Go's IPMask.Size for a canonical mask: its leading ones. */
export function maskOnes(mask: Uint8Array): number {
	return [...mask].reduce((count, byte) => count + byte.toString(2).replace(/0/gu, '').length, 0);
}

/** Go's IP.Equal: the same address, an IPv4 one compared with its IPv6 mapping. */
function ipEqual(a: IP, b: IP): boolean {
	if (a.length === b.length) return a.every((byte, index) => byte === b[index]);
	const four = to4(a.length === 4 ? b : a);
	const other = a.length === 4 ? a : b;
	return four !== undefined && four.length === 4 && other.length === 4 && four.every((byte, index) => byte === other[index]);
}

const isZero = (ip: IP): boolean => ipEqual(ip, ipv4(0, 0, 0, 0)) || ipEqual(ip, new Uint8Array(16));

/** go-cidr's checkIPv4: an IPv4 address as its 4 bytes. */
const checkIPv4 = (ip: IP): IP => to4(ip) ?? ip;

/** go-cidr's Inc and Dec: the address one above or below, wrapping round. */
function step(ip: IP, by: 1 | -1): IP {
	const out = Uint8Array.from(checkIPv4(ip));
	for (let index = out.length - 1; index >= 0; index--) {
		out[index] = (out[index] + by) & 0xff;
		if (by === 1 ? out[index] !== 0 : out[index] !== 0xff) break;
	}
	return out;
}

/** Go's IP.Mask, with Go's nil address, here empty, where the mask does not fit the address. */
const masked = (ip: IP, mask: Uint8Array): IP => maskIP(ip, mask) ?? new Uint8Array(0);

/** go-cidr's PreviousSubnet: the subnet of a prefix length just below a network's start, and whether it wrapped. */
export function previousSubnet(network: IPNet, prefixLength: number): [IPNet, boolean] {
	const start = checkIPv4(network.ip);
	const mask = cidrMask(prefixLength, 8 * start.length);
	return [{ ip: masked(step(start, -1), mask), mask }, isZero(start)];
}

/** go-cidr's NextSubnet: the subnet of a prefix length just after a network's end, and whether it wrapped. */
export function nextSubnet(network: IPNet, prefixLength: number): [IPNet, boolean] {
	const [, currentLast] = addressRange(network);
	const mask = cidrMask(prefixLength, 8 * currentLast.length);
	const [, last] = addressRange({ ip: masked(currentLast, mask), mask });
	const following = step(last, 1);
	return [{ ip: masked(following, mask), mask }, isZero(following)];
}

/** Go's IP.String: dotted for an IPv4 address, else IPv6 with its longest run of two or more zero groups as "::". */
export function ipString(ip: IP): string {
	if (ip.length === 0) return '<nil>';
	const four = to4(ip);
	if (four) return [...four].join('.');
	let e0 = -1;
	let e1 = -1;
	for (let index = 0; index < 16; index += 2) {
		let end = index;
		while (end < 16 && ip[end] === 0 && ip[end + 1] === 0) end += 2;
		if (end > index && end - index > e1 - e0) {
			e0 = index;
			e1 = end;
			index = end;
		}
	}
	if (e1 - e0 <= 2) {
		e0 = -1;
		e1 = -1;
	}
	let text = '';
	for (let index = 0; index < 16; index += 2) {
		if (index === e0) {
			text += '::';
			index = e1;
			if (index >= 16) break;
		} else if (index > 0) {
			text += ':';
		}
		text += ((ip[index] << 8) | ip[index + 1]).toString(16);
	}
	return text;
}

/**
 * Go's IPNet.String for a canonical mask: the address and its prefix length, or "<nil>" for an address and mask that
 * make no network.
 */
export function ipNetString(network: IPNet): string {
	const ip = to4(network.ip) ?? (network.ip.length === 16 ? network.ip : undefined);
	const { mask } = network;
	if (!ip || (mask.length !== 4 && mask.length !== 16) || (mask.length === 4 && ip.length !== 4)) return '<nil>';
	return `${ipString(ip)}/${maskOnes(mask)}`;
}
