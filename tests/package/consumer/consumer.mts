import {ParsedDocument, Workspace, synthesizeDefinition, type ModuleType} from 'tghclparser';

export type Document = ParsedDocument;
export type Root = Workspace;
export type Synthesize = typeof synthesizeDefinition;
export type Module = ModuleType;
