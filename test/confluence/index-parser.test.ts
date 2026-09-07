import { describe, expect, it } from "vitest";
import { parseGuideIndex } from "../../src/confluence/index-parser.js";

const STORAGE_FIXTURE = `
<p>Curated guides for AI-agent planning.</p>
<table>
  <tbody>
    <tr>
      <th><p>Title</p></th>
      <th><p>Description</p></th>
      <th><p>Link</p></th>
      <th><p>Tags</p></th>
    </tr>
    <tr>
      <td><p>Symfony 4→5 Upgrade</p></td>
      <td><p>Steps for upgrading 4.4 apps to 5.x</p></td>
      <td><p><a href="https://example.atlassian.net/wiki/spaces/ENG/pages/111/Symfony+4-5">link</a></p></td>
      <td><p>symfony, upgrade</p></td>
    </tr>
    <tr>
      <td><p>Company Conventions</p></td>
      <td><p>Coding standards, PR process, testing expectations</p></td>
      <td><p><a href="https://example.atlassian.net/wiki/spaces/ENG/pages/222/Conventions">link</a></p></td>
      <td><p>always</p></td>
    </tr>
  </tbody>
</table>
`;

describe("parseGuideIndex", () => {
  it("parses each data row into a GuideIndexEntry, skipping the header row", () => {
    const entries = parseGuideIndex(STORAGE_FIXTURE);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      title: "Symfony 4→5 Upgrade",
      description: "Steps for upgrading 4.4 apps to 5.x",
      link: "https://example.atlassian.net/wiki/spaces/ENG/pages/111/Symfony+4-5",
      tags: ["symfony", "upgrade"],
    });
    expect(entries[1]).toEqual({
      title: "Company Conventions",
      description: "Coding standards, PR process, testing expectations",
      link: "https://example.atlassian.net/wiki/spaces/ENG/pages/222/Conventions",
      tags: ["always"],
    });
  });

  it("leaves lastModified undefined on a legacy 4-column table (no Last Modified header at all)", () => {
    const entries = parseGuideIndex(STORAGE_FIXTURE);
    expect(entries).toHaveLength(2);
    expect(entries[0].lastModified).toBeUndefined();
    expect(entries[1].lastModified).toBeUndefined();
  });

  it("parses a 5th Last Modified column by header text into lastModified", () => {
    const storage = `
      <table><tbody>
        <tr><th><p>Title</p></th><th><p>Description</p></th><th><p>Link</p></th><th><p>Tags</p></th><th><p>Last Modified</p></th></tr>
        <tr>
          <td><p>Symfony 4→5 Upgrade</p></td>
          <td><p>Steps for upgrading 4.4 apps to 5.x</p></td>
          <td><p><a href="https://x/pages/1/y">link</a></p></td>
          <td><p>symfony, upgrade</p></td>
          <td><p>2026-09-06</p></td>
        </tr>
      </tbody></table>`;
    const entries = parseGuideIndex(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0].lastModified).toBe("2026-09-06");
  });

  it("maps an empty Last Modified cell to undefined, not an error and not an empty string", () => {
    const storage = `
      <table><tbody>
        <tr><th><p>Title</p></th><th><p>Description</p></th><th><p>Link</p></th><th><p>Tags</p></th><th><p>Last Modified</p></th></tr>
        <tr>
          <td><p>Company Conventions</p></td>
          <td><p>Coding standards, PR process, testing expectations</p></td>
          <td><p><a href="https://x/pages/2/y">link</a></p></td>
          <td><p>always</p></td>
          <td><p></p></td>
        </tr>
      </tbody></table>`;
    const entries = parseGuideIndex(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0].lastModified).toBeUndefined();
  });

  it("returns an empty array when the page has no table", () => {
    expect(parseGuideIndex("<p>Nothing here yet.</p>")).toEqual([]);
  });

  it("decodes named/numeric HTML entities Confluence introduces on save (found live, real Cloud instance)", () => {
    const storage = `
      <table><tbody>
        <tr><th>Title</th><th>Description</th><th>Link</th><th>Tags</th></tr>
        <tr>
          <td><p>Symfony 4&rarr;5 Upgrade</p></td>
          <td><p>An em&mdash;dash &amp; a numeric ref: &#8594;</p></td>
          <td><p><a href="https://x/pages/1/y">link</a></p></td>
          <td><p>symfony</p></td>
        </tr>
      </tbody></table>`;
    const entries = parseGuideIndex(storage);
    expect(entries).toEqual([
      {
        title: "Symfony 4→5 Upgrade",
        description: "An em—dash & a numeric ref: →",
        link: "https://x/pages/1/y",
        tags: ["symfony"],
      },
    ]);
  });

  it("skips a malformed row with fewer than 4 cells", () => {
    const malformed = `
      <table><tbody>
        <tr><th>Title</th><th>Description</th><th>Link</th><th>Tags</th></tr>
        <tr><td>Only one cell</td></tr>
        <tr>
          <td><p>Valid Row</p></td><td><p>d</p></td>
          <td><p><a href="https://x/pages/1/y">l</a></p></td><td><p>t</p></td>
        </tr>
      </tbody></table>`;
    const entries = parseGuideIndex(malformed);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Valid Row");
  });
});
