import { describe, expect, it } from "vitest";
import { storageToPlainText } from "../../src/confluence/storage-text.js";

describe("storageToPlainText", () => {
  it("strips basic paragraph/heading/list markup", () => {
    const html = "<h1>Title</h1><p>Intro.</p><ul><li>One</li><li>Two</li></ul>";
    expect(storageToPlainText(html)).toBe("Title\nIntro.\n- One\n- Two");
  });

  it("decodes named/numeric HTML entities Confluence introduces on save (found live, real Cloud instance)", () => {
    expect(storageToPlainText("<p>Symfony 4&rarr;5, an em&mdash;dash, &amp; a numeric ref: &#8594;</p>")).toBe(
      "Symfony 4→5, an em—dash, & a numeric ref: →",
    );
  });

  it("preserves a code macro's CDATA body verbatim (regression: the generic tag-strip regex " +
    "previously matched <![CDATA[...]]> as one giant tag and deleted the real command content, " +
    "found live against a real Confluence page)", () => {
    const html =
      "<p>Run this:</p>" +
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">none</ac:parameter>' +
      "<ac:plain-text-body><![CDATA[composer update symfony/* --with-all-dependencies\n" +
      "vendor/bin/phpunit]]></ac:plain-text-body></ac:structured-macro>" +
      "<p>Done.</p>";
    const text = storageToPlainText(html);
    expect(text).toContain("composer update symfony/* --with-all-dependencies");
    expect(text).toContain("vendor/bin/phpunit");
    expect(text).not.toContain("none");
    expect(text).not.toMatch(/CODE_BLOCK/);
  });

  it("handles multiple code macros on the same page, each kept distinct", () => {
    const macro = (code: string) =>
      `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`;
    const html = `<p>Step 1</p>${macro("echo one")}<p>Step 2</p>${macro("echo two")}`;
    const text = storageToPlainText(html);
    expect(text).toContain("echo one");
    expect(text).toContain("echo two");
    expect(text.indexOf("echo one")).toBeLessThan(text.indexOf("echo two"));
  });

  it("collapses 3+ blank lines down to a single blank line", () => {
    expect(storageToPlainText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });
});
