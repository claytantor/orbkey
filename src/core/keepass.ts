/**
 * KeePass 2.x XML export parser.
 *
 * Parses an unencrypted KeePass XML export and returns a flat list of
 * KeePassEntry objects. Group hierarchy is flattened into `labels`. History
 * entries and binary attachments are skipped.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { XMLParser } from 'fast-xml-parser';

export interface KeePassEntry {
  title: string;
  password: string;
  username: string;
  url: string;
  notes: string;
  labels: string[];
}

/** Normalize fast-xml-parser output: an element may be one object or an array. */
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) {
    return [];
  }
  return Array.isArray(v) ? v : [v];
}

interface XmlNode {
  [k: string]: unknown;
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) {
    return '';
  }
  // fast-xml-parser stores element text in `#text` when attrs/children exist,
  // or as the scalar directly otherwise.
  if (typeof v === 'object') {
    const node = v as XmlNode;
    if ('#text' in node) {
      return String(node['#text'] ?? '');
    }
    return '';
  }
  return String(v);
}

function parseEntry(entryEl: XmlNode, labels: string[]): KeePassEntry | null {
  const strings: Record<string, string> = {};
  for (const s of asArray<XmlNode>(entryEl.String as XmlNode | XmlNode[])) {
    const key = textOf(s.Key);
    // Value may be empty string; keep it.
    const valueRaw = s.Value;
    const value =
      valueRaw === undefined || valueRaw === null
        ? ''
        : typeof valueRaw === 'object'
          ? textOf(valueRaw)
          : String(valueRaw);
    if (key) {
      strings[key] = value;
    }
  }
  const title = strings.Title ?? '';
  if (!title) {
    return null;
  }
  return {
    title,
    password: strings.Password ?? '',
    username: strings.UserName ?? '',
    url: strings.URL ?? '',
    notes: strings.Notes ?? '',
    labels: [...new Set(labels)],
  };
}

function walkGroup(group: XmlNode, pathLabels: string[]): KeePassEntry[] {
  const entries: KeePassEntry[] = [];
  // Direct entries in this group (history lives under Entry/History, which we
  // never recurse into).
  for (const e of asArray<XmlNode>(group.Entry as XmlNode | XmlNode[])) {
    const parsed = parseEntry(e, pathLabels);
    if (parsed) {
      entries.push(parsed);
    }
  }
  for (const sub of asArray<XmlNode>(group.Group as XmlNode | XmlNode[])) {
    const subName = textOf(sub.Name);
    const subLabels = subName ? [...pathLabels, subName] : [...pathLabels];
    entries.push(...walkGroup(sub, subLabels));
  }
  return entries;
}

export function parseKeepassXmlString(xml: string): KeePassEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: true,
    // Keep text under #text only when needed; scalars stay scalar.
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as XmlNode;
  const file = doc.KeePassFile as XmlNode | undefined;
  if (!file) {
    return [];
  }
  const root = file.Root as XmlNode | undefined;
  if (!root) {
    return [];
  }
  // <Root><Group>...</Group></Root> — the top group is the vault root.
  const rootGroups = asArray<XmlNode>(root.Group as XmlNode | XmlNode[]);
  const rootGroup = rootGroups[0];
  if (!rootGroup) {
    return [];
  }
  const entries: KeePassEntry[] = [];
  // Entries directly under the root group carry no labels.
  for (const e of asArray<XmlNode>(rootGroup.Entry as XmlNode | XmlNode[])) {
    const parsed = parseEntry(e, []);
    if (parsed) {
      entries.push(parsed);
    }
  }
  for (const sub of asArray<XmlNode>(rootGroup.Group as XmlNode | XmlNode[])) {
    const subName = textOf(sub.Name);
    const subLabels = subName ? [subName] : [];
    entries.push(...walkGroup(sub, subLabels));
  }
  return entries;
}

function expandHome(p: string): string {
  if (p === '~') {
    return homedir();
  }
  if (p.startsWith('~/')) {
    return homedir() + p.slice(1);
  }
  return p;
}

export function parseKeepassXml(path: string): KeePassEntry[] {
  const xml = readFileSync(expandHome(path), 'utf-8');
  return parseKeepassXmlString(xml);
}
