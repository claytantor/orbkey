/** KeePass 2.x XML parser (mirrors test_keepass.py). */
import { describe, it, expect } from 'vitest';
import { parseKeepassXmlString, parseKeepassXml } from '../src/core/keepass.js';
import { existsSync } from 'node:fs';

const SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<KeePassFile>
  <Root>
    <Group>
      <Name>Root</Name>
      <Entry>
        <String><Key>Title</Key><Value>github</Value></String>
        <String><Key>Password</Key><Value>sekret123</Value></String>
        <String><Key>UserName</Key><Value>clay</Value></String>
        <String><Key>URL</Key><Value>https://github.com</Value></String>
        <String><Key>Notes</Key><Value>my notes</Value></String>
      </Entry>
    </Group>
  </Root>
</KeePassFile>`;

const NESTED = `<?xml version="1.0" encoding="UTF-8"?>
<KeePassFile>
  <Root>
    <Group>
      <Name>Root</Name>
      <Group>
        <Name>services</Name>
        <Group>
          <Name>aws</Name>
          <Entry>
            <String><Key>Title</Key><Value>prod key</Value></String>
            <String><Key>Password</Key><Value>pwd</Value></String>
          </Entry>
        </Group>
        <Entry>
          <String><Key>Title</Key><Value>root</Value></String>
          <String><Key>Password</Key><Value>r00t</Value></String>
        </Entry>
      </Group>
    </Group>
  </Root>
</KeePassFile>`;

const WITH_HISTORY = `<?xml version="1.0" encoding="UTF-8"?>
<KeePassFile>
  <Root>
    <Group>
      <Name>Root</Name>
      <Entry>
        <String><Key>Title</Key><Value>current</Value></String>
        <String><Key>Password</Key><Value>newpw</Value></String>
        <History>
          <Entry>
            <String><Key>Title</Key><Value>old</Value></String>
            <String><Key>Password</Key><Value>oldpw</Value></String>
          </Entry>
        </History>
      </Entry>
    </Group>
  </Root>
</KeePassFile>`;

const MISSING_TITLE = `<?xml version="1.0" encoding="UTF-8"?>
<KeePassFile>
  <Root>
    <Group>
      <Name>Root</Name>
      <Entry>
        <String><Key>Password</Key><Value>nope</Value></String>
      </Entry>
    </Group>
  </Root>
</KeePassFile>`;

const EMPTY_FIELDS = `<?xml version="1.0" encoding="UTF-8"?>
<KeePassFile>
  <Root>
    <Group>
      <Name>Root</Name>
      <Entry>
        <String><Key>Title</Key><Value>minimal</Value></String>
        <String><Key>Password</Key><Value>x</Value></String>
      </Entry>
    </Group>
  </Root>
</KeePassFile>`;

describe('keepass', () => {
  it('parses a single entry', () => {
    const entries = parseKeepassXmlString(SINGLE);
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.title).toBe('github');
    expect(e.password).toBe('sekret123');
    expect(e.username).toBe('clay');
    expect(e.url).toBe('https://github.com');
    expect(e.notes).toBe('my notes');
    expect(e.labels).toEqual([]);
  });

  it('flattens nested groups into labels', () => {
    const entries = parseKeepassXmlString(NESTED);
    expect(entries.length).toBe(2);
    const deep = entries.find((e) => e.title === 'prod key')!;
    expect(deep.labels).toEqual(['services', 'aws']);
    const shallow = entries.find((e) => e.title === 'root')!;
    expect(shallow.labels).toEqual(['services']);
  });

  it('skips history entries', () => {
    const entries = parseKeepassXmlString(WITH_HISTORY);
    expect(entries.length).toBe(1);
    expect(entries[0]!.title).toBe('current');
    expect(entries[0]!.password).toBe('newpw');
  });

  it('skips entries missing a title', () => {
    expect(parseKeepassXmlString(MISSING_TITLE).length).toBe(0);
  });

  it('empty optional fields are empty strings', () => {
    const e = parseKeepassXmlString(EMPTY_FIELDS)[0]!;
    expect(e.username).toBe('');
    expect(e.url).toBe('');
    expect(e.notes).toBe('');
  });

  it('parses a real export if present', () => {
    // Opt-in: point ORBKEY_KEEPASS_FIXTURE at a real KeePass XML export to run.
    const real = process.env.ORBKEY_KEEPASS_FIXTURE;
    if (!real || !existsSync(real)) {
      return; // skip
    }
    const entries = parseKeepassXml(real);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.url).length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.labels.length > 0).length).toBeGreaterThan(0);
  });
});
