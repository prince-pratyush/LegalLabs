import { describe, expect, it } from "vitest";
import { MAX_TEXT, readPage } from "./extract.js";

describe("readPage", () => {
  it("keeps the readable words, the title and the paragraph breaks", () => {
    const page = readPage(
      "<!doctype html><html><head><title>Rules &amp; notices</title></head>" +
        "<body><h1>Part 1</h1><p>The <i>s</i>ection applies.</p><p>Fees are &#163;5.</p></body></html>",
    );
    expect(page.title).toBe("Rules & notices");
    expect(page.text).toBe("Part 1\nThe section applies.\nFees are £5.");
  });

  it("drops scripts, styles, frames, forms controls and comments", () => {
    const page = readPage(
      "<p>kept</p><script>var a = '</p>';alert(1)</script><style>p{}</style>" +
        "<!-- planted --><noscript>no</noscript><template>t</template><iframe>f</iframe>" +
        "<svg><text>vector</text></svg><select><option>o</option></select><p>also</p>",
    );
    expect(page.text).toBe("kept\nalso");
  });

  it("drops text a reader would not see", () => {
    const page = readPage(
      "<p>seen</p><div hidden>a</div><div aria-hidden=true>b</div>" +
        '<div style="color:red; display : none">c<div>nested</div>still</div>' +
        "<span style='visibility:hidden'>d</span><span style=font-size:0px>e</span>" +
        '<span style="opacity: 0">f</span><p>end</p>',
    );
    expect(page.text).toBe("seen\nend");
  });

  it("stays silent when a hidden or script element is never closed", () => {
    expect(readPage("<p>a</p><div hidden><p>b</p>").text).toBe("a");
    expect(readPage("<p>a</p><script>b</p>c").text).toBe("a");
  });

  it("reads a quoted > inside a tag as part of the tag", () => {
    expect(readPage('<a title="x > y">link</a>').text).toBe("link");
  });

  it("removes invisible and control characters", () => {
    expect(readPage("<p>ig​nore‮ me\u0000</p>").text).toBe("ignore me");
  });

  it("is linear on hostile markup and caps what it keeps", () => {
    const started = Date.now();
    readPage("<div>".repeat(200_000));
    readPage("</p>".repeat(200_000));
    readPage(`<a ${"x=1 ".repeat(200_000)}`);
    readPage("<".repeat(500_000));
    expect(readPage("word ".repeat(200_000)).text.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
