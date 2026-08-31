import { describe, expect, it } from "vitest";
import { adfToPlainText, plainTextToAdf } from "../../src/jira/adf.js";

describe("adfToPlainText", () => {
  it("returns an empty string for null/undefined/non-object input", () => {
    expect(adfToPlainText(null)).toBe("");
    expect(adfToPlainText(undefined)).toBe("");
    expect(adfToPlainText("not an object")).toBe("");
  });

  it("extracts text from a single paragraph", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
    };
    expect(adfToPlainText(doc)).toBe("Hello world");
  });

  it("joins multiple paragraphs with newlines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    };
    expect(adfToPlainText(doc)).toBe("First\nSecond");
  });

  it("extracts text from a heading", () => {
    const doc = { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Title" }] }] };
    expect(adfToPlainText(doc)).toBe("Title");
  });

  it("extracts text from a list item", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "text", text: "Item one" }] }],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("Item one");
  });

  it("concatenates multiple text nodes within the same block", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
        },
      ],
    };
    expect(adfToPlainText(doc)).toBe("Hello world");
  });
});

describe("plainTextToAdf", () => {
  it("wraps a single line as one paragraph", () => {
    expect(plainTextToAdf("single line")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "single line" }] }],
    });
  });

  it("splits blank-line-separated text into multiple paragraphs", () => {
    const adf = plainTextToAdf("para one\n\npara two");
    expect(adf.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "para one" }] },
      { type: "paragraph", content: [{ type: "text", text: "para two" }] },
    ]);
  });

  it("round-trips paragraph content, though adfToPlainText joins with a single newline", () => {
    // plainTextToAdf splits on blank lines ("\n\n") but adfToPlainText joins blocks with a single
    // "\n" — this pair isn't a lossless round-trip for paragraph spacing, only for the text content.
    const adf = plainTextToAdf("para one\n\npara two");
    expect(adfToPlainText(adf)).toBe("para one\npara two");
  });
});
