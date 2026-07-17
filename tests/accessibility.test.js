import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import axe from "axe-core";

test("the initial page has no automatically detectable structural accessibility violations", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://example.test/"
  });
  dom.window.eval(axe.source);
  const result = await dom.window.axe.run(dom.window.document, {
    rules: {
      "color-contrast": { enabled: false },
      "scrollable-region-focusable": { enabled: false }
    }
  });
  const violations = Array.from(result.violations, ({ id, help, nodes }) => ({
    id,
    help,
    targets: Array.from(nodes, (node) => Array.from(node.target))
  }));
  assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  dom.window.close();
});
