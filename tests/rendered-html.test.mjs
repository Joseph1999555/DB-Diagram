import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

test("build emits the Relix workspace", async () => {
  const [workspace, layout] = await Promise.all([
    readFile(new URL("../components/diagram-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  await access(new URL("../dist/server/index.js", import.meta.url));
  assert.match(workspace, /Northstar Commerce/);
  assert.match(workspace, /Schema source/);
  assert.match(workspace, /Valid DBML/);
  assert.match(layout, /Relix/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(workspace, /Your site is taking shape/);
});

test("removes starter-preview infrastructure and ships product metadata", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /DiagramWorkspace/);
  assert.match(layout, /Relix/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app\/_sites-preview/SkeletonPreview.tsx", templateRoot)));
});
