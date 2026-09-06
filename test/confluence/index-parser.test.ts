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

  it("returns an empty array when the page has no table", () => {
    expect(parseGuideIndex("<p>Nothing here yet.</p>")).toEqual([]);
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
