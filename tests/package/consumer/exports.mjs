import {createRequire} from 'node:module';
import * as esm from 'tghclparser';

export const esmNames = Object.keys(esm).filter(name => name !== 'default').sort();
export const cjsNames = Object.keys(createRequire(import.meta.url)('tghclparser')).sort();
